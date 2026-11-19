// Gen402 x402 gateway — plain Node.js (no framework).
// Serves the frontend, the listing catalogue, and the x402 flow:
//   GET /data/:id  without payment  -> HTTP 402 + machine-readable price
//   GET /data/:id  with X-Payment: <txHash> + X-Buyer: <address>
//     -> verifies on-chain access, serves the upstream data, records the
//        call on-chain with use_call() when a gateway key is configured.
//
// Env:
//   PORT              default 8787
//   CONTRACT_ADDRESS  Gen402 contract on studionet (0x...). If unset, the
//                     gateway runs in labelled DEMO mode against
//                     data/listings.json and accepts X-Payment: demo.
//   RPC_URL           default https://studio.genlayer.com/api
//   GATEWAY_PRIVATE_KEY  optional throwaway studionet key, used only to
//                     call use_call() / verify_delivery(). Never commit it.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8787);
const RPC_URL = process.env.RPC_URL || "https://studio.genlayer.com/api";
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS || "").trim() || null;
const GATEWAY_PRIVATE_KEY = (process.env.GATEWAY_PRIVATE_KEY || "").trim() || null;
const CHAIN_ID = 61999; // GenLayer studionet
const EXPLORER = "https://explorer-studio.genlayer.com/address";

const mirror = JSON.parse(
  await readFile(path.join(ROOT, "data", "listings.json"), "utf-8")
);

let sdk = null; // lazy-loaded genlayer-js (ESM-only)
let client = null;
let gatewayAccount = null;

async function getClient() {
  if (client) return client;
  sdk = await import("genlayer-js");
  const { studionet } = await import("genlayer-js/chains");
  const config = { chain: studionet, endpoint: RPC_URL };
  if (GATEWAY_PRIVATE_KEY) {
    gatewayAccount = sdk.createAccount(
      GATEWAY_PRIVATE_KEY.startsWith("0x")
        ? GATEWAY_PRIVATE_KEY
        : `0x${GATEWAY_PRIVATE_KEY}`
    );
    config.account = gatewayAccount;
  }
  client = sdk.createClient(config);
  return client;
}

async function contractRead(functionName, args = []) {
  const c = await getClient();
  return c.readContract({ address: CONTRACT_ADDRESS, functionName, args });
}

async function contractWrite(functionName, args = [], value = 0n) {
  const c = await getClient();
  if (!gatewayAccount) throw new Error("GATEWAY_PRIVATE_KEY not configured");
  const hash = await c.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    value,
  });
  return hash;
}

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(body);
}

function x402Body(listing) {
  const amount = listing.price_wei; // wei, as a decimal string
  return {
    x402Version: 1,
    error: "Payment Required",
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${CHAIN_ID}`,
        asset: "GEN",
        amount,
        payTo: CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000",
        description: `${listing.title} — ${listing.price_human}`,
        mimeType: "application/json",
        maxTimeoutSeconds: 300,
        extra: {
          contract: CONTRACT_ADDRESS,
          listingId: listing.id,
          model: listing.model_name,
          howToPay:
            "Call buy_access(listingId) for paywall/subscription or buy_credits(listingId, credits) for metered, with value = price, then retry with X-Payment: <txHash> and X-Buyer: <your address>.",
        },
      },
    ],
  };
}

async function getListings() {
  if (!CONTRACT_ADDRESS) return mirror;
  try {
    const raw = await contractRead("list_listings", []);
    const onchain = JSON.parse(raw);
    // Enrich with verdicts (best-effort).
    for (const l of onchain) {
      try {
        const v = await contractRead("get_verdict", [l.id]);
        if (v) l.verdict = JSON.parse(v);
      } catch { /* verdict not set yet */ }
    }
    return onchain.length ? onchain : mirror;
  } catch (e) {
    console.error("contract list_listings failed, using mirror:", e.message);
    return mirror;
  }
}

async function verifyPayment(listing, req) {
  const txHash = req.headers["x-payment"];
  const buyer = req.headers["x-buyer"];
  if (!txHash || !buyer) return { ok: false, reason: "missing X-Payment / X-Buyer headers" };
  if (!CONTRACT_ADDRESS) {
    // Labelled demo mode only — no contract configured, nothing on-chain to check.
    if (txHash === "demo") return { ok: true, demo: true, buyer };
    return { ok: false, reason: "demo mode: use X-Payment: demo (no contract configured)" };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: "X-Payment must be a 0x transaction hash" };
  }
  // Authoritative check: does the buyer actually hold access on-chain?
  let hasAccess = false;
  try {
    hasAccess = await contractRead("has_access", [buyer, listing.id]);
  } catch (e) {
    return { ok: false, reason: `contract read failed: ${e.message}` };
  }
  if (!hasAccess) {
    return { ok: false, reason: "no on-chain access for this buyer (pay first, wait for finalization)" };
  }
  // Bind the presented tx hash to the exact purchase: load the GenLayer
  // transaction and require from == buyer, to == this contract, and the
  // decoded call to be buy_access/buy_credits for THIS listing with the
  // right value. (A bare receipt check cannot tell a deploy or a
  // create_listing tx from a purchase — the readable calldata can.)
  let receiptNote;
  try {
    const c = await getClient();
    const tx = await c.getTransaction({ hash: txHash });
    if (!tx) return { ok: false, reason: "no such transaction on studionet" };
    const from = String(tx.from_address || tx.from || "").toLowerCase();
    const to = String(tx.to_address || tx.to || "").toLowerCase();
    if (from !== String(buyer).toLowerCase()) {
      return { ok: false, reason: `tx is from ${tx.from_address}, not the presented buyer ${buyer}` };
    }
    if (to !== CONTRACT_ADDRESS.toLowerCase()) {
      return { ok: false, reason: `tx target ${tx.to_address} is not the marketplace contract` };
    }
    // The decoded call lives at tx.data.calldata.readable, but it is a
    // Python-style repr, not strict JSON (e.g. {"args":[1,]"method":
    // "buy_access"} — trailing comma, missing comma). Parse it tolerantly.
    let method = null;
    let args = null;
    try {
      const readable = tx.data?.calldata?.readable || tx.data?.readable || tx.readable || "";
      const mMethod = String(readable).match(/"method"\s*:\s*"([^"]+)"/);
      const mArgs = String(readable).match(/"args"\s*:\s*\[([^\]]*)\]/);
      if (mMethod) method = mMethod[1];
      if (mArgs) {
        args = mArgs[1].split(",").map((t) => t.trim()).filter((t) => t !== "")
          .map((t) => {
            const q = t.match(/^"(.*)"$/);
            if (q) return q[1];
            const n = Number(t);
            return Number.isNaN(n) ? t : n;
          });
      }
    } catch { /* not decodable */ }
    if (method !== "buy_access" && method !== "buy_credits") {
      return { ok: false, reason: `tx called ${method || "an undecodable method"}, not a purchase` };
    }
    if (!args || Number(args[0]) !== listing.id) {
      return { ok: false, reason: `tx bought listing ${args ? args[0] : "?"}, not ${listing.id}` };
    }
    const paid = BigInt(tx.value ?? 0);
    const expected = method === "buy_access"
      ? BigInt(listing.price_wei)
      : BigInt(args[1]) * BigInt(listing.price_wei);
    if (paid !== expected) {
      return { ok: false, reason: `tx paid ${paid} wei, expected ${expected} wei` };
    }
    receiptNote = `verified purchase tx: ${method}(${args.join(", ")}) value ${paid} wei`;
  } catch (e) {
    return { ok: false, reason: `cannot verify tx ${txHash}: ${e.message}` };
  }
  return { ok: true, buyer, txHash, receiptNote };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const [, route, param] = url.pathname.split("/");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(path.join(ROOT, "frontend", "index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(html);
    }

    if (url.pathname === "/listings") {
      const listings = await getListings();
      return send(res, 200, {
        contract: CONTRACT_ADDRESS,
        explorer: CONTRACT_ADDRESS ? `${EXPLORER}/${CONTRACT_ADDRESS}` : null,
        chainId: CHAIN_ID,
        demoMode: !CONTRACT_ADDRESS,
        listings,
      });
    }

    if (route === "data" && param) {
      const id = Number(param);
      const listings = await getListings();
      const listing = listings.find((l) => l.id === id);
      if (!listing) return send(res, 404, { error: `listing ${id} not found` });

      const check = await verifyPayment(listing, req);
      if (!check.ok) {
        return send(res, 402, x402Body(listing), {
          "PAYMENT-REQUIRED": "x402",
          "X-Gen402-Reason": check.reason,
        });
      }

      // Paid: fetch the upstream data server-side and serve it.
      const upstream = await fetch(listing.data_url, {
        headers: { "User-Agent": "Gen402-gateway/1.0", Accept: "application/json" },
      });
      if (!upstream.ok) {
        return send(res, 502, { error: `upstream ${listing.data_url} returned ${upstream.status}` });
      }
      const data = await upstream.text();

      // Record the call on-chain (metered / subscription only; paywall is
      // unlimited so use_call is a no-op). Best-effort, never blocks the 200.
      let metered = "skipped-no-gateway-key";
      if (GATEWAY_PRIVATE_KEY && CONTRACT_ADDRESS && listing.model !== 0) {
        try {
          const hash = await contractWrite("use_call", [id, check.buyer]);
          metered = `recorded on-chain: ${hash}`;
        } catch (e) {
          metered = `use_call failed: ${e.message}`;
        }
      } else if (listing.model === 0) {
        metered = "paywall: unlimited, nothing to deduct";
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Payment-Response": JSON.stringify({ txHash: check.txHash || "demo", buyer: check.buyer }),
        "X-Gen402-Metered": metered,
        "X-Gen402-Receipt": check.receiptNote || "demo mode",
      });
      return res.end(data);
    }

    if (route === "verify" && param && req.method === "POST") {
      if (!CONTRACT_ADDRESS || !GATEWAY_PRIVATE_KEY) {
        return send(res, 400, { error: "verify needs CONTRACT_ADDRESS + GATEWAY_PRIVATE_KEY" });
      }
      const hash = await contractWrite("verify_delivery", [Number(param)]);
      return send(res, 200, { tx: hash, note: "verify_delivery submitted; wait for consensus, then GET /listings for the verdict" });
    }

    if (url.pathname === "/health") {
      return send(res, 200, { ok: true, contract: CONTRACT_ADDRESS, demoMode: !CONTRACT_ADDRESS });
    }

    return send(res, 404, { error: "not found", routes: ["GET /", "GET /listings", "GET /data/:id", "POST /verify/:id", "GET /health"] });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, () => {
  console.log(`Gen402 gateway on http://localhost:${PORT}`);
  console.log(`Contract: ${CONTRACT_ADDRESS || "(none — DEMO mode, X-Payment: demo)"}`);
  console.log(`RPC: ${RPC_URL}  chain: ${CHAIN_ID}`);
});
