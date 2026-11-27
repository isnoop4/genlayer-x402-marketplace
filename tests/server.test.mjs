// HTTP-level checks: the real gateway/server.js started in DEMO mode (no
// contract, no network; the upstream fetch is the only outside call and the
// tests that need it are skipped when it is unreachable).
//   node --test tests/*.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  const env = { ...process.env, PORT: String(PORT), GATEWAY_ID: BASE };
  delete env.CONTRACT_ADDRESS; delete env.GATEWAY_PRIVATE_KEY;
  child = spawn(process.execPath, [path.join(ROOT, "gateway", "server.js")], { env, stdio: "ignore" });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("gateway did not start");
});
after(() => child && child.kill("SIGTERM"));

test("HTTP: no proof -> 402 with the x402 body and proof instructions", async () => {
  const r = await fetch(`${BASE}/data/2`);
  assert.equal(r.status, 402);
  const j = await r.json();
  assert.equal(j.x402Version, 1);
  assert.match(j.accepts[0].extra.howToProve, /challenge/);
});

test("HTTP: tx hash + address headers only -> 402", async () => {
  const r = await fetch(`${BASE}/data/1`, { headers: { "X-Payment": "0x" + "ab".repeat(32), "X-Buyer": "0xfD7d408f5Cc0A4d507bDc41c48B4A00A8C9Fc399" } });
  assert.equal(r.status, 402);
  assert.match(r.headers.get("x-gen402-reason"), /not accepted as proof/);
});

test("HTTP: challenge is bound to the request, and a forged or replayed proof is rejected", async () => {
  const buyer = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey());
  const c = await (await fetch(`${BASE}/challenge/1?buyer=${buyer.address}`)).json();
  assert.ok(c.message.includes(`Gateway: ${BASE}`));
  assert.ok(c.message.includes("Listing: 1"));
  const forged = await fetch(`${BASE}/data/1`, { headers: { "X-Buyer": buyer.address, "X-Nonce": c.nonce, "X-Signature": await attacker.signMessage({ message: c.message }) } });
  assert.equal(forged.status, 401);
  const wrongListing = await fetch(`${BASE}/data/2`, { headers: { "X-Buyer": buyer.address, "X-Nonce": c.nonce, "X-Signature": await buyer.signMessage({ message: c.message }) } });
  assert.equal(wrongListing.status, 401);
  assert.equal((await fetch(`${BASE}/challenge/1?buyer=nope`)).status, 400);
  assert.equal((await fetch(`${BASE}/challenge/999?buyer=${buyer.address}`)).status, 404);
});

test("HTTP: page and scripts are served with a CSP that forbids inline script", async () => {
  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  const html = await page.text();
  assert.ok(!/<script>(?!\s*<\/script>)/.test(html), "page has an inline script block");
  for (const f of ["/render.js", "/app.js"]) assert.equal((await fetch(BASE + f)).status, 200);
});
