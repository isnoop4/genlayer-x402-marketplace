// Gen402 gateway core — the access decision, with every outside dependency
// injected so it can be tested without a network (see tests/gateway.test.mjs).
//
// What a paid request has to prove, in order:
//   1. Control of the buyer account: a wallet signature (EIP-191
//      personal_sign) over a challenge this gateway issued. The challenge is
//      single-use, expires after a short time, and is bound to one buyer, one
//      listing, this gateway, this contract and this chain. A transaction
//      hash and an address are public, so they prove nothing and are ignored.
//   2. On-chain access for that buyer (has_access on the contract).
//   3. For metered / subscription listings: one credit consumed on-chain by
//      use_call(), FINALIZED with a successful execution result, BEFORE any
//      data is released. No gateway key, a failed, reverted or unfinalized
//      consumption: no data.
// Requests for the same (buyer, listing) run one at a time, so the second of
// two simultaneous requests is judged on the state the first one left.

export const DEFAULT_CHALLENGE_TTL_MS = 120_000;
export const DEFAULT_MAX_CHALLENGES = 5_000;
export const DEFAULT_MAX_CHALLENGES_PER_BUYER = 8;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^0x[0-9a-f]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// Reasons can carry upstream / RPC error text. Make them safe to put in an
// HTTP header: one line of printable ASCII, capped.
export function headerSafe(value, max = 300) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function isAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

// The exact text the buyer's wallet signs. Every field that scopes the proof
// is in the signed text, so a signature cannot be moved to another listing,
// buyer, gateway, contract or chain.
export function buildChallengeMessage({ gatewayId, contract, chainId, listingId, buyer, nonce, expiresAt }) {
  return [
    "Gen402 data request",
    `Gateway: ${gatewayId}`,
    `Contract: ${contract}`,
    `Chain: eip155:${chainId}`,
    `Listing: ${listingId}`,
    `Buyer: ${String(buyer).toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
  ].join("\n");
}

// Refuse upstream URLs that are not plain public http(s). A seller chooses
// data_url, and the gateway fetches it server-side.
export function isPublicHttpUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host.includes(":")) return false; // IPv6 literal
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

export function x402Body({ listing, contract, chainId, gatewayId }) {
  return {
    x402Version: 1,
    error: "Payment Required",
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${chainId}`,
        asset: "GEN",
        amount: String(listing.price_wei),
        payTo: contract || "0x0000000000000000000000000000000000000000",
        description: `${listing.title} — ${listing.price_human || listing.price_wei + " wei"}`,
        mimeType: "application/json",
        maxTimeoutSeconds: 300,
        extra: {
          contract,
          listingId: listing.id,
          model: listing.model_name || ["paywall", "metered", "subscription"][listing.model],
          gateway: gatewayId,
          howToPay:
            "Call buy_access(listingId) for paywall/subscription or buy_credits(listingId, credits) for metered, with value = price, and wait for finalization.",
          howToProve:
            "GET /challenge/<listingId>?buyer=<your address>, sign the returned message with that account (personal_sign), then retry GET /data/<listingId> with X-Buyer, X-Nonce and X-Signature. Each challenge works once and expires. A transaction hash is not accepted as proof.",
        },
      },
    ],
  };
}

export function createGateway(deps) {
  const {
    contractAddress,
    chainId,
    gatewayId,
    chain, // { hasAccess(buyer, id), canConsume(), consumeCall(id, buyer) }
    fetchUpstream, // (url) => { ok, status, body }
    recoverSigner, // ({ message, signature }) => address
    randomNonce, // () => "0x" + 64 hex
    now = () => Date.now(),
    ttlMs = DEFAULT_CHALLENGE_TTL_MS,
    maxChallenges = DEFAULT_MAX_CHALLENGES,
    maxChallengesPerBuyer = DEFAULT_MAX_CHALLENGES_PER_BUYER,
    demoMode = false,
  } = deps;

  const challenges = new Map(); // nonce -> { buyer, listingId, message, expiresAt, used }
  const locks = new Map(); // "<buyer>:<listing>" -> tail promise

  function prune() {
    const t = now();
    for (const [nonce, c] of challenges) {
      if (c.expiresAt <= t) challenges.delete(nonce);
    }
  }

  function payRequired(listing, reason) {
    return {
      status: 402,
      headers: { "PAYMENT-REQUIRED": "x402", "X-Gen402-Reason": headerSafe(reason) },
      body: x402Body({ listing, contract: contractAddress, chainId, gatewayId }),
    };
  }
  const refuse = (status, reason) => ({
    status,
    headers: { "X-Gen402-Reason": headerSafe(reason) },
    body: { error: headerSafe(reason) },
  });

  function issueChallenge({ listing, buyer }) {
    if (!isAddress(buyer)) return refuse(400, "buyer must be a 0x address (query ?buyer=0x...)");
    prune();
    const key = buyer.toLowerCase();
    let open = 0;
    for (const c of challenges.values()) if (c.buyer === key && !c.used) open += 1;
    if (open >= maxChallengesPerBuyer) return refuse(429, "too many open challenges for this buyer; use one or wait for them to expire");
    if (challenges.size >= maxChallenges) return refuse(429, "too many open challenges; try again shortly");
    const nonce = randomNonce();
    const expiresAt = now() + ttlMs;
    const message = buildChallengeMessage({
      gatewayId, contract: contractAddress, chainId, listingId: listing.id, buyer: key, nonce, expiresAt,
    });
    challenges.set(nonce, { buyer: key, listingId: listing.id, message, expiresAt, used: false });
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: {
        listingId: listing.id,
        buyer: key,
        nonce,
        expiresAt: new Date(expiresAt).toISOString(),
        message,
        sign: "personal_sign (EIP-191) over `message` with the buyer account",
        then: `GET /data/${listing.id} with headers X-Buyer, X-Nonce, X-Signature`,
      },
    };
  }

  // Run fn after every earlier request for the same key has finished.
  function withLock(key, fn) {
    const tail = locks.get(key) || Promise.resolve();
    const run = tail.then(fn, fn);
    const settled = run.then(() => {}, () => {});
    locks.set(key, settled);
    settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
    return run;
  }

  async function proveBuyer(listing, headers) {
    const buyer = headers["x-buyer"];
    const nonce = headers["x-nonce"];
    const signature = headers["x-signature"];
    if (!nonce && !signature) {
      const tx = headers["x-payment"];
      if (tx || buyer) {
        return {
          fail: payRequired(listing,
            (tx && TX_HASH_RE.test(String(tx)) ? "a transaction hash and an address are public and are not accepted as proof; " : "")
            + "request a challenge and sign it with the buyer account"),
        };
      }
      return { fail: payRequired(listing, "no proof presented") };
    }
    if (!isAddress(buyer)) return { fail: refuse(401, "X-Buyer must be a 0x address") };
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return { fail: refuse(401, "X-Nonce is missing or malformed") };
    if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) return { fail: refuse(401, "X-Signature is missing or malformed") };

    const c = challenges.get(nonce);
    if (!c) return { fail: refuse(401, "unknown challenge: this gateway did not issue that nonce, or it has expired") };
    if (c.used) return { fail: refuse(401, "challenge already used (replay rejected); request a new one") };
    if (c.expiresAt <= now()) {
      challenges.delete(nonce);
      return { fail: refuse(401, "challenge expired; request a new one") };
    }
    const key = buyer.toLowerCase();
    if (c.buyer !== key) return { fail: refuse(401, "challenge was issued for a different buyer") };
    if (c.listingId !== listing.id) return { fail: refuse(401, "challenge was issued for a different listing") };

    let signer;
    try {
      signer = await recoverSigner({ message: c.message, signature });
    } catch {
      return { fail: refuse(401, "signature could not be verified") };
    }
    if (String(signer).toLowerCase() !== key) {
      // The nonce is NOT burned here: a wrong signature must not let a third
      // party cancel the real buyer's challenge.
      return { fail: refuse(401, "signature is not from the buyer account") };
    }
    // Re-check after the await, then burn the nonce in the same tick, so two
    // simultaneous presentations of one valid proof cannot both pass.
    if (c.used) return { fail: refuse(401, "challenge already used (replay rejected); request a new one") };
    c.used = true;
    return { buyer: key };
  }

  async function serve(listing, buyer) {
    let hasAccess;
    try {
      hasAccess = demoMode ? true : await chain.hasAccess(buyer, listing.id);
    } catch (e) {
      return refuse(502, `contract read failed: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
    }
    if (!hasAccess) {
      return payRequired(listing, "no on-chain access for this buyer: nothing bought, refunded, or no calls left");
    }

    const metered = !demoMode && Number(listing.model) !== 0;
    if (metered && !chain.canConsume()) {
      return refuse(503, "this gateway has no key to record credit consumption, so metered and subscription data cannot be released");
    }
    if (!isPublicHttpUrl(listing.data_url)) {
      return refuse(502, "listing source is not a public http(s) URL; nothing fetched, no credit consumed");
    }

    // Fetch first and HOLD the body: a dead upstream must not cost a credit.
    let upstream;
    try {
      upstream = await fetchUpstream(listing.data_url);
    } catch (e) {
      return refuse(502, `upstream fetch failed: ${String(e && e.message ? e.message : e).slice(0, 200)}; no credit consumed`);
    }
    if (!upstream || !upstream.ok) {
      return refuse(502, `upstream returned ${upstream ? upstream.status : "nothing"}; no credit consumed`);
    }

    const headers = { "X-Gen402-Buyer": buyer };
    if (!metered) {
      headers["X-Gen402-Metered"] = demoMode ? "demo mode: nothing on-chain" : "paywall: unlimited, nothing to consume";
      return { status: 200, headers, raw: upstream.body };
    }

    // Metered / subscription: release only after a finalized, successful
    // use_call(). Anything else: the held body is dropped.
    let used;
    try {
      used = await chain.consumeCall(listing.id, buyer);
    } catch (e) {
      return refuse(502, `credit consumption failed: ${String(e && e.message ? e.message : e).slice(0, 200)}; no data released`);
    }
    if (!used || used.finalized !== true || used.success !== true) {
      const why = used && used.reason ? used.reason : "not finalized with a successful result";
      const status = used && used.noCredits ? 402 : 502;
      if (status === 402) return payRequired(listing, `credit consumption rejected: ${why}; no data released`);
      const r = refuse(502, `credit consumption failed: ${why}; no data released`);
      if (used && used.hash) r.headers["X-Gen402-Consumption"] = used.hash;
      return r;
    }
    headers["X-Gen402-Metered"] = "one call consumed on-chain, FINALIZED";
    headers["X-Gen402-Consumption"] = used.hash;
    if (used.callsLeft !== undefined && used.callsLeft !== null) headers["X-Gen402-Calls-Left"] = String(used.callsLeft);
    return { status: 200, headers, raw: upstream.body };
  }

  async function handleData({ listing, headers }) {
    const proof = await proveBuyer(listing, headers || {});
    if (proof.fail) return proof.fail;
    return withLock(`${proof.buyer}:${listing.id}`, () => serve(listing, proof.buyer));
  }

  return {
    issueChallenge,
    handleData,
    // test / health visibility only
    _openChallenges: () => { prune(); return challenges.size; },
    _activeLocks: () => locks.size,
  };
}
