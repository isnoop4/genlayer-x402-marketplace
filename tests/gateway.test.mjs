// Focused checks for the gateway's access decision (gateway/core.js).
// No network: the chain is a small in-memory fake that behaves like the
// contract's has_access / use_call, signatures are real EIP-191 signatures
// made with throwaway keys generated in the test process.
//   node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createGateway, headerSafe, isPublicHttpUrl } from "../gateway/core.js";

const CONTRACT = "0x3B0850628992B0F322D1Af7196a9337AdF7655B4";
const PAYWALL = { id: 1, title: "BTC", model: 0, price_wei: "1000000000000000000", data_url: "https://example.com/btc" };
const METERED = { id: 2, title: "Weather", model: 1, price_wei: "100000000000000000", data_url: "https://example.com/weather" };
const SUBSCRIPTION = { id: 3, title: "Brief", model: 2, price_wei: "2000000000000000000", data_url: "https://example.com/brief" };
const DATA = '{"secret":"paid data"}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Behaves like the contract: has_access is true while calls are left (or
// access is unlimited); use_call takes one call and fails at zero.
function fakeChain({ credits = {}, unlimited = [], hasKey = true, consume = "ok", delayMs = 15 } = {}) {
  const left = new Map(Object.entries(credits)); // "<buyer>:<id>" -> n
  const open = new Set(unlimited);
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    left, calls,
    maxInFlight: () => maxInFlight,
    hasAccess: async (buyer, id) => open.has(`${buyer}:${id}`) || (left.get(`${buyer}:${id}`) || 0) > 0,
    canConsume: () => hasKey,
    consumeCall: async (id, buyer) => {
      calls.push(`${buyer}:${id}`);
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(delayMs); // "waiting for finalization"
      inFlight -= 1;
      if (consume === "throw") throw new Error("rpc down");
      if (consume === "reverted") return { finalized: true, success: false, hash: "0x" + "ab".repeat(32), reason: "ended FINALIZED / FINISHED_WITH_ERROR / MAJORITY_AGREE" };
      if (consume === "not-finalized") return { finalized: false, success: false, hash: "0x" + "cd".repeat(32), reason: "did not finalize in time" };
      if (consume === "accepted-only") return { finalized: false, success: true, hash: "0x" + "ef".repeat(32), reason: "ACCEPTED, not FINALIZED" };
      const n = left.get(`${buyer}:${id}`) || 0;
      if (n <= 0) return { finalized: false, success: false, noCredits: true, reason: "no calls left for this buyer" };
      left.set(`${buyer}:${id}`, n - 1);
      return { finalized: true, success: true, hash: "0x" + randomBytes(32).toString("hex"), callsLeft: n - 1 };
    },
  };
}

function setup(chainOpts = {}, extra = {}) {
  const clock = { t: 1_800_000_000_000 };
  const chain = typeof chainOpts.hasAccess === "function" ? chainOpts : fakeChain(chainOpts);
  const upstream = { fetched: 0 };
  const gw = createGateway({
    contractAddress: CONTRACT, chainId: 61999, gatewayId: "https://gateway.test",
    chain,
    fetchUpstream: async () => { upstream.fetched += 1; return extra.upstream || { ok: true, status: 200, body: DATA }; },
    recoverSigner: recoverMessageAddress,
    randomNonce: () => "0x" + randomBytes(32).toString("hex"),
    now: () => clock.t,
    ttlMs: 120_000,
    ...extra.deps,
  });
  return { gw, chain, clock, upstream };
}

const newBuyer = () => privateKeyToAccount(generatePrivateKey());
const addr = (account) => account.address.toLowerCase();

async function proof(gw, listing, account, signer = account) {
  const c = gw.issueChallenge({ listing, buyer: account.address });
  assert.equal(c.status, 200);
  const signature = await signer.signMessage({ message: c.body.message });
  return { "x-buyer": account.address, "x-nonce": c.body.nonce, "x-signature": signature };
}

const released = (out) => out.raw !== undefined;

// ---------------------------------------------------------------- no proof
test("no proof -> 402 with the x402 price, no data", async () => {
  const { gw, upstream } = setup();
  const out = await gw.handleData({ listing: PAYWALL, headers: {} });
  assert.equal(out.status, 402);
  assert.equal(out.body.accepts[0].payTo, CONTRACT);
  assert.equal(out.body.accepts[0].amount, PAYWALL.price_wei);
  assert.ok(!released(out));
  assert.equal(upstream.fetched, 0);
});

test("public tx hash + buyer address alone (the old flow) -> 402, no data", async () => {
  const buyer = newBuyer();
  const { gw, upstream } = setup({ unlimited: [`${addr(buyer)}:1`] }); // the buyer really did pay
  const out = await gw.handleData({
    listing: PAYWALL,
    headers: { "x-payment": "0xe9dcb85e4e6194b0683ea9312253d33678561c4b930c7c4ae9e3f2b236a78f14", "x-buyer": buyer.address },
  });
  assert.equal(out.status, 402);
  assert.match(out.headers["X-Gen402-Reason"], /not accepted as proof/);
  assert.ok(!released(out));
  assert.equal(upstream.fetched, 0);
});

// ----------------------------------------------------- impersonation/replay
test("impersonation: challenge for the buyer signed by another key -> 401, no data", async () => {
  const buyer = newBuyer();
  const attacker = newBuyer();
  const { gw, upstream } = setup({ unlimited: [`${addr(buyer)}:1`] });
  const headers = await proof(gw, PAYWALL, buyer, attacker);
  const out = await gw.handleData({ listing: PAYWALL, headers });
  assert.equal(out.status, 401);
  assert.match(out.headers["X-Gen402-Reason"], /not from the buyer account/);
  assert.ok(!released(out));
  assert.equal(upstream.fetched, 0);
});

test("impersonation: a failed forgery does not burn the real buyer's challenge", async () => {
  const buyer = newBuyer();
  const attacker = newBuyer();
  const { gw } = setup({ unlimited: [`${addr(buyer)}:1`] });
  const c = gw.issueChallenge({ listing: PAYWALL, buyer: buyer.address });
  const forged = await attacker.signMessage({ message: c.body.message });
  const bad = await gw.handleData({ listing: PAYWALL, headers: { "x-buyer": buyer.address, "x-nonce": c.body.nonce, "x-signature": forged } });
  assert.equal(bad.status, 401);
  const good = await gw.handleData({ listing: PAYWALL, headers: { "x-buyer": buyer.address, "x-nonce": c.body.nonce, "x-signature": await buyer.signMessage({ message: c.body.message }) } });
  assert.equal(good.status, 200);
  assert.equal(good.raw, DATA);
});

test("impersonation: attacker's own valid proof does not unlock the buyer's access", async () => {
  const buyer = newBuyer();
  const attacker = newBuyer();
  const { gw } = setup({ unlimited: [`${addr(buyer)}:1`] });
  // (a) attacker proves control of the attacker account -> no on-chain access
  const own = await gw.handleData({ listing: PAYWALL, headers: await proof(gw, PAYWALL, attacker) });
  assert.equal(own.status, 402);
  assert.ok(!released(own));
  // (b) attacker's challenge presented under the buyer's address
  const headers = await proof(gw, PAYWALL, attacker);
  headers["x-buyer"] = buyer.address;
  const swapped = await gw.handleData({ listing: PAYWALL, headers });
  assert.equal(swapped.status, 401);
  assert.match(swapped.headers["X-Gen402-Reason"], /different buyer/);
});

test("replay: the same signed challenge works once, then is rejected", async () => {
  const buyer = newBuyer();
  const { gw, upstream } = setup({ unlimited: [`${addr(buyer)}:1`] });
  const headers = await proof(gw, PAYWALL, buyer);
  const first = await gw.handleData({ listing: PAYWALL, headers });
  assert.equal(first.status, 200);
  const second = await gw.handleData({ listing: PAYWALL, headers });
  assert.equal(second.status, 401);
  assert.match(second.headers["X-Gen402-Reason"], /already used/);
  assert.ok(!released(second));
  assert.equal(upstream.fetched, 1);
});

test("replay: two simultaneous presentations of one proof -> exactly one passes", async () => {
  const buyer = newBuyer();
  const { gw, chain } = setup({ credits: { [`${addr(buyer)}:2`]: 5 } });
  const headers = await proof(gw, METERED, buyer);
  const outs = await Promise.all([1, 2, 3].map(() => gw.handleData({ listing: METERED, headers })));
  assert.equal(outs.filter(released).length, 1);
  assert.equal(outs.filter((o) => o.status === 401).length, 2);
  assert.equal(chain.left.get(`${addr(buyer)}:2`), 4); // one credit, not three
});

test("replay: a proof for listing #1 cannot be used on listing #2", async () => {
  const buyer = newBuyer();
  const { gw, chain } = setup({ unlimited: [`${addr(buyer)}:1`], credits: { [`${addr(buyer)}:2`]: 1 } });
  const headers = await proof(gw, PAYWALL, buyer);
  const out = await gw.handleData({ listing: METERED, headers });
  assert.equal(out.status, 401);
  assert.match(out.headers["X-Gen402-Reason"], /different listing/);
  assert.equal(chain.calls.length, 0);
});

test("expired challenge -> 401; a nonce this gateway never issued -> 401", async () => {
  const buyer = newBuyer();
  const { gw, clock } = setup({ unlimited: [`${addr(buyer)}:1`] });
  const headers = await proof(gw, PAYWALL, buyer);
  clock.t += 120_001;
  const late = await gw.handleData({ listing: PAYWALL, headers });
  assert.equal(late.status, 401);
  assert.match(late.headers["X-Gen402-Reason"], /expired/);
  assert.ok(!released(late));

  const made = "0x" + randomBytes(32).toString("hex");
  const signature = await buyer.signMessage({ message: "Gen402 data request\nNonce: " + made });
  const unknown = await gw.handleData({ listing: PAYWALL, headers: { "x-buyer": buyer.address, "x-nonce": made, "x-signature": signature } });
  assert.equal(unknown.status, 401);
  assert.match(unknown.headers["X-Gen402-Reason"], /unknown challenge/);
});

test("the signed text names the listing, buyer, gateway, contract, chain, nonce and expiry", () => {
  const buyer = newBuyer();
  const { gw } = setup();
  const c = gw.issueChallenge({ listing: METERED, buyer: buyer.address });
  for (const part of ["Listing: 2", `Buyer: ${addr(buyer)}`, "Gateway: https://gateway.test", `Contract: ${CONTRACT}`, "Chain: eip155:61999", `Nonce: ${c.body.nonce}`, "Expires: "]) {
    assert.ok(c.body.message.includes(part), part);
  }
  assert.equal(gw.issueChallenge({ listing: METERED, buyer: "not-an-address" }).status, 400);
});

test("open challenges per buyer are capped", () => {
  const buyer = newBuyer();
  const { gw } = setup();
  for (let i = 0; i < 8; i += 1) assert.equal(gw.issueChallenge({ listing: PAYWALL, buyer: buyer.address }).status, 200);
  assert.equal(gw.issueChallenge({ listing: PAYWALL, buyer: buyer.address }).status, 429);
});

// --------------------------------------------- finalized consumption first
test("metered: data is released only after a finalized, successful consumption", async () => {
  const buyer = newBuyer();
  const { gw, chain } = setup({ credits: { [`${addr(buyer)}:2`]: 2 } });
  const out = await gw.handleData({ listing: METERED, headers: await proof(gw, METERED, buyer) });
  assert.equal(out.status, 200);
  assert.equal(out.raw, DATA);
  assert.match(out.headers["X-Gen402-Consumption"], /^0x[0-9a-f]{64}$/);
  assert.equal(out.headers["X-Gen402-Calls-Left"], "1");
  assert.deepEqual(chain.calls, [`${addr(buyer)}:2`]);
});

test("missing gateway key: metered and subscription requests are refused, no data, no consumption", async () => {
  const buyer = newBuyer();
  const { gw, chain, upstream } = setup({ hasKey: false, credits: { [`${addr(buyer)}:2`]: 3, [`${addr(buyer)}:3`]: 30 } });
  for (const listing of [METERED, SUBSCRIPTION]) {
    const out = await gw.handleData({ listing, headers: await proof(gw, listing, buyer) });
    assert.equal(out.status, 503);
    assert.match(out.headers["X-Gen402-Reason"], /no key/);
    assert.ok(!released(out));
  }
  assert.equal(chain.calls.length, 0);
  assert.equal(upstream.fetched, 0);
});

for (const [mode, label] of [
  ["throw", "consumption call throws"],
  ["reverted", "consumption finalized with an error result"],
  ["not-finalized", "consumption never finalizes"],
  ["accepted-only", "consumption accepted but not finalized"],
]) {
  test(`failed consumption (${label}) -> 502, no data`, async () => {
    const buyer = newBuyer();
    const { gw } = setup({ consume: mode, credits: { [`${addr(buyer)}:3`]: 30 } });
    const out = await gw.handleData({ listing: SUBSCRIPTION, headers: await proof(gw, SUBSCRIPTION, buyer) });
    assert.equal(out.status, 502);
    assert.match(out.headers["X-Gen402-Reason"], /no data released/);
    assert.ok(!released(out));
    assert.ok(!JSON.stringify(out.body).includes("paid data"));
  });
}

test("no credits left -> 402 before any fetch or consumption", async () => {
  const buyer = newBuyer();
  const { gw, chain, upstream } = setup({ credits: { [`${addr(buyer)}:2`]: 0 } });
  const out = await gw.handleData({ listing: METERED, headers: await proof(gw, METERED, buyer) });
  assert.equal(out.status, 402);
  assert.ok(!released(out));
  assert.equal(chain.calls.length, 0);
  assert.equal(upstream.fetched, 0);
});

test("stale access read: the chain refuses the consumption -> 402, no data", async () => {
  const buyer = newBuyer();
  const chain = fakeChain({ credits: { [`${addr(buyer)}:2`]: 0 } });
  chain.hasAccess = async () => true; // e.g. another gateway instance used the last credit
  const { gw } = setup(chain);
  const out = await gw.handleData({ listing: METERED, headers: await proof(gw, METERED, buyer) });
  assert.equal(out.status, 402);
  assert.match(out.headers["X-Gen402-Reason"], /no data released/);
  assert.ok(!released(out));
});

test("dead upstream: 502 and no credit is consumed", async () => {
  const buyer = newBuyer();
  const { gw, chain } = setup({ credits: { [`${addr(buyer)}:2`]: 1 } }, { upstream: { ok: false, status: 500, body: "" } });
  const out = await gw.handleData({ listing: METERED, headers: await proof(gw, METERED, buyer) });
  assert.equal(out.status, 502);
  assert.equal(chain.calls.length, 0);
  assert.equal(chain.left.get(`${addr(buyer)}:2`), 1);
});

// -------------------------------------------------------------- concurrency
test("concurrent: two signed requests, one credit left -> exactly one is served", async () => {
  const buyer = newBuyer();
  const { gw, chain } = setup({ credits: { [`${addr(buyer)}:2`]: 1 } });
  const [h1, h2] = [await proof(gw, METERED, buyer), await proof(gw, METERED, buyer)];
  const outs = await Promise.all([gw.handleData({ listing: METERED, headers: h1 }), gw.handleData({ listing: METERED, headers: h2 })]);
  assert.equal(outs.filter(released).length, 1);
  const refused = outs.find((o) => !released(o));
  assert.equal(refused.status, 402);
  assert.equal(chain.left.get(`${addr(buyer)}:2`), 0);
  assert.equal(chain.calls.length, 1); // the loser was judged after the winner finished
  assert.equal(chain.maxInFlight(), 1);
});

test("concurrent: 6 signed requests, 3 credits -> 3 served, never more than one consumption in flight", async () => {
  const buyer = newBuyer();
  const { gw, chain } = setup({ credits: { [`${addr(buyer)}:2`]: 3 } });
  const proofs = [];
  for (let i = 0; i < 6; i += 1) proofs.push(await proof(gw, METERED, buyer));
  const outs = await Promise.all(proofs.map((headers) => gw.handleData({ listing: METERED, headers })));
  assert.equal(outs.filter(released).length, 3);
  assert.equal(outs.filter((o) => o.status === 402).length, 3);
  assert.equal(chain.left.get(`${addr(buyer)}:2`), 0);
  assert.equal(chain.maxInFlight(), 1);
  assert.equal(gw._activeLocks(), 0);
});

test("concurrent: a failed request does not block the next one for the same buyer", async () => {
  const buyer = newBuyer();
  const chain = fakeChain({ credits: { [`${addr(buyer)}:2`]: 2 } });
  let first = true;
  const real = chain.consumeCall;
  chain.consumeCall = async (id, b) => { if (first) { first = false; throw new Error("rpc down"); } return real(id, b); };
  const { gw } = setup(chain);
  const [h1, h2] = [await proof(gw, METERED, buyer), await proof(gw, METERED, buyer)];
  const outs = await Promise.all([gw.handleData({ listing: METERED, headers: h1 }), gw.handleData({ listing: METERED, headers: h2 })]);
  assert.deepEqual(outs.map((o) => o.status).sort(), [200, 502]);
});

test("different buyers are not serialized against each other", async () => {
  const [a, b] = [newBuyer(), newBuyer()];
  const { gw, chain } = setup({ credits: { [`${addr(a)}:2`]: 1, [`${addr(b)}:2`]: 1 }, delayMs: 40 });
  const outs = await Promise.all([
    gw.handleData({ listing: METERED, headers: await proof(gw, METERED, a) }),
    gw.handleData({ listing: METERED, headers: await proof(gw, METERED, b) }),
  ]);
  assert.equal(outs.filter(released).length, 2);
  assert.equal(chain.maxInFlight(), 2);
});

// ------------------------------------------------------------------ paywall
test("paywall: signed proof + on-chain access -> data, nothing consumed", async () => {
  const buyer = newBuyer();
  const { gw, chain } = setup({ unlimited: [`${addr(buyer)}:1`], hasKey: false });
  const out = await gw.handleData({ listing: PAYWALL, headers: await proof(gw, PAYWALL, buyer) });
  assert.equal(out.status, 200);
  assert.equal(out.raw, DATA);
  assert.equal(chain.calls.length, 0);
});

test("upstream URL guard: only public http(s) sources are fetched", () => {
  for (const ok of ["https://api.open-meteo.com/v1/forecast?x=1", "http://example.com/a"]) assert.equal(isPublicHttpUrl(ok), true, ok);
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "http://localhost:8787/", "http://127.0.0.1/", "http://169.254.169.254/latest", "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/", "http://user:pw@example.com/", "nonsense"]) {
    assert.equal(isPublicHttpUrl(bad), false, bad);
  }
});

test("failure reasons with newlines or non-ASCII text are safe to send as an HTTP header", async () => {
  const buyer = newBuyer();
  const chain = fakeChain({ credits: { [`${addr(buyer)}:2`]: 1 } });
  chain.consumeCall = async () => { throw new Error("An unknown RPC error occurred.\n\nDetails: Rate limit exceeded — 30/min\r\nVersion: x"); };
  const { gw } = setup(chain);
  const out = await gw.handleData({ listing: METERED, headers: await proof(gw, METERED, buyer) });
  assert.equal(out.status, 502);
  assert.match(out.headers["X-Gen402-Reason"], /^[\x20-\x7e]+$/);
  assert.ok(!released(out));
  assert.equal(headerSafe("a\r\nSet-Cookie: x=1"), "a Set-Cookie: x=1");
});
