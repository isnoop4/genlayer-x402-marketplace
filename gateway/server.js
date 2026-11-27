// Gen402 x402 gateway — plain Node.js (no framework).
//
//   GET  /data/:id                      no proof            -> HTTP 402 + price
//   GET  /challenge/:id?buyer=0x...     single-use challenge to sign
//   GET  /data/:id  + X-Buyer, X-Nonce, X-Signature
//        -> signature must come from the buyer account (EIP-191), the
//           challenge must be unused and unexpired, the buyer must hold
//           access on-chain, and for metered / subscription listings one
//           credit must be consumed on-chain and FINALIZED before any data
//           is released. See gateway/core.js for the exact rules.
//
// A transaction hash plus an address is NOT accepted as proof: both are
// public on the explorer.
//
// Env:
//   PORT                 default 8787
//   CONTRACT_ADDRESS     Gen402 contract on studionet (0x...). If unset, the
//                        gateway runs in labelled DEMO mode against
//                        data/listings.json (signature still required,
//                        nothing on-chain is checked).
//   RPC_URL              default https://studio.genlayer.com/api
//   GATEWAY_PRIVATE_KEY  throwaway studionet key of the account registered
//                        with set_gateway(). Required for metered and
//                        subscription listings: without it those requests are
//                        refused. Needs a little GEN for protocol fees.
//                        Read from the environment only. Never commit it.
//   GATEWAY_ID           public origin of this gateway, written into every
//                        challenge (default http://localhost:<PORT>).
//   CHALLENGE_TTL_MS     default 120000
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8787);
const RPC_URL = process.env.RPC_URL || "https://studio.genlayer.com/api";
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS || "").trim() || null;
const GATEWAY_PRIVATE_KEY = (process.env.GATEWAY_PRIVATE_KEY || "").trim() || null;
const GATEWAY_ID = (process.env.GATEWAY_ID || "").trim() || `http://localhost:${PORT}`;
const TTL_MS = Number(process.env.CHALLENGE_TTL_MS || 120000);
const CHAIN_ID = 61999; // GenLayer studionet
const EXPLORER = "https://explorer-studio.genlayer.com/address";
const DEMO = !CONTRACT_ADDRESS;

const mirror = JSON.parse(await readFile(path.join(ROOT, "data", "listings.json"), "utf-8"));

let chainPromise = null; // lazy: genlayer-js is slow to load
function getChain() {
  if (!chainPromise) {
    chainPromise = import("./chain.js").then((m) => m.createStudionetChain({
      rpcUrl: RPC_URL,
      contractAddress: CONTRACT_ADDRESS,
      gatewayPrivateKey: GATEWAY_PRIVATE_KEY,
      log: (line) => console.log(line),
    }));
  }
  return chainPromise;
}

let recoverMessageAddress = null;
async function recoverSigner({ message, signature }) {
  if (!recoverMessageAddress) ({ recoverMessageAddress } = await import("viem"));
  return recoverMessageAddress({ message, signature });
}

const gateway = createGateway({
  contractAddress: CONTRACT_ADDRESS,
  chainId: CHAIN_ID,
  gatewayId: GATEWAY_ID,
  demoMode: DEMO,
  ttlMs: TTL_MS,
  randomNonce: () => "0x" + randomBytes(32).toString("hex"),
  recoverSigner,
  chain: {
    hasAccess: async (buyer, id) => (await getChain()).hasAccess(buyer, id),
    canConsume: () => Boolean(GATEWAY_PRIVATE_KEY),
    consumeCall: async (id, buyer) => (await getChain()).consumeCall(id, buyer),
  },
  fetchUpstream: async (url) => {
    const r = await fetch(url, {
      headers: { "User-Agent": "Gen402-gateway/2.0", Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    return { ok: r.ok, status: r.status, body: await r.text() };
  },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "X-Buyer, X-Nonce, X-Signature, X-Payment, Content-Type",
  "Access-Control-Expose-Headers":
    "X-Gen402-Reason, X-Gen402-Metered, X-Gen402-Consumption, X-Gen402-Calls-Left, X-Gen402-Buyer, PAYMENT-REQUIRED",
};

function send(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...CORS, ...extraHeaders });
  res.end(JSON.stringify(obj, null, 2));
}

// Listings are read from the contract and cached: Studio's public RPC allows
// about 30 requests a minute, and a paid request must spend them on the
// access check and the consumption, not on re-reading the catalogue.
// With a contract configured there is NO fallback to the local mirror: if the
// catalogue cannot be read and nothing is cached, the request fails.
const LISTINGS_TTL_MS = Number(process.env.LISTINGS_TTL_MS || 300000);
let cache = null; // { at, listings }
async function getListings({ withVerdicts = false } = {}) {
  if (DEMO) return mirror;
  const fresh = cache && Date.now() - cache.at < LISTINGS_TTL_MS;
  if (!fresh || (withVerdicts && !cache.verdicts)) {
    try {
      const chain = await getChain();
      const listings = JSON.parse(await chain.read("list_listings", []));
      let verdicts = false;
      if (withVerdicts) {
        for (const l of listings) {
          try {
            const v = await chain.read("get_verdict", [l.id]);
            if (v) l.verdict = JSON.parse(v);
          } catch { /* verdict not set yet */ }
        }
        verdicts = true;
      }
      cache = { at: Date.now(), listings, verdicts };
    } catch (e) {
      console.error("contract list_listings failed:", String(e.message).split("\n")[0]);
      if (!cache) throw new Error("catalogue unavailable");
    }
  }
  return cache.listings;
}

const STATIC = {
  "/": ["frontend/index.html", "text/html; charset=utf-8"],
  "/index.html": ["frontend/index.html", "text/html; charset=utf-8"],
  "/render.js": ["docs/render.js", "text/javascript; charset=utf-8"],
  "/app.js": ["frontend/app.js", "text/javascript; charset=utf-8"],
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const [, route, param] = url.pathname.split("/");

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        // The page builds its DOM with textContent only; this is a second line of defence.
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'none'; object-src 'none'; base-uri 'none'",
      });
      return res.end(await readFile(path.join(ROOT, file)));
    }

    if (url.pathname === "/listings") {
      return send(res, 200, {
        contract: CONTRACT_ADDRESS,
        explorer: CONTRACT_ADDRESS ? `${EXPLORER}/${CONTRACT_ADDRESS}` : null,
        chainId: CHAIN_ID,
        demoMode: DEMO,
        gateway: GATEWAY_ID,
        meteredEnabled: Boolean(GATEWAY_PRIVATE_KEY),
        listings: await getListings({ withVerdicts: true }),
      });
    }

    if ((route === "data" || route === "challenge") && param) {
      const id = Number(param);
      const listing = Number.isInteger(id) ? (await getListings()).find((l) => l.id === id) : null;
      if (!listing) return send(res, 404, { error: "listing not found" });

      if (route === "challenge") {
        const out = gateway.issueChallenge({ listing, buyer: url.searchParams.get("buyer") });
        return send(res, out.status, out.body, out.headers);
      }

      const out = await gateway.handleData({ listing, headers: req.headers });
      if (out.raw !== undefined) {
        res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", ...CORS, ...out.headers });
        return res.end(out.raw);
      }
      return send(res, out.status, out.body, out.headers);
    }

    if (route === "verify" && param && req.method === "POST") {
      if (DEMO || !GATEWAY_PRIVATE_KEY) {
        return send(res, 400, { error: "verify needs CONTRACT_ADDRESS + GATEWAY_PRIVATE_KEY" });
      }
      const hash = await (await getChain()).verifyDelivery(Number(param));
      return send(res, 200, { tx: hash, note: "verify_delivery submitted; wait for consensus, then GET /listings for the verdict" });
    }

    if (url.pathname === "/health") {
      return send(res, 200, { ok: true, contract: CONTRACT_ADDRESS, demoMode: DEMO, meteredEnabled: Boolean(GATEWAY_PRIVATE_KEY) });
    }

    return send(res, 404, { error: "not found", routes: ["GET /", "GET /listings", "GET /challenge/:id?buyer=0x...", "GET /data/:id", "POST /verify/:id", "GET /health"] });
  } catch (e) {
    console.error(String(e && e.message ? e.message : e).split("\n")[0]);
    if (res.headersSent) return res.end();
    const unavailable = e && e.message === "catalogue unavailable";
    return send(res, unavailable ? 503 : 500, { error: unavailable ? "catalogue unavailable: the contract could not be read" : "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`Gen402 gateway on http://localhost:${PORT} (id ${GATEWAY_ID})`);
  console.log(`Contract: ${CONTRACT_ADDRESS || "(none — DEMO mode, nothing on-chain is checked)"}`);
  console.log(`RPC: ${RPC_URL}  chain: ${CHAIN_ID}`);
  console.log(`Metered/subscription: ${GATEWAY_PRIVATE_KEY ? "enabled (gateway key present)" : "REFUSED (no GATEWAY_PRIVATE_KEY)"}`);
});

