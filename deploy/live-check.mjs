// Live check of the Gen402 gateway rules against the deployed contract on
// studionet. Starts real gateway processes, pays with a throwaway buyer, and
// records every result (public data only) in live-check-results.json.
//
// Usage:
//   CONTRACT=0x... OWNER_PRIVATE_KEY=0x<contract owner key> node deploy/live-check.mjs
//
// OWNER_PRIVATE_KEY is used for exactly one transaction: set_gateway(<fresh
// throwaway gateway account>). It is read from the environment only and never
// printed, logged or written. Without it the script runs as a REHEARSAL: the
// gateway account is not registered, so metered consumption is expected to
// fail closed (useful on its own: it shows "failed consumption -> no data").
//
// The gateway, buyer and attacker accounts are generated in memory, funded
// through Studio's sim_fundAccount, and their keys are discarded on exit.
// Every write is sent once; nothing is re-sent.
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RPC_URL = process.env.RPC_URL || "https://studio.genlayer.com/api";
const CONTRACT = (process.env.CONTRACT || "").trim();
const OWNER_KEY = (process.env.OWNER_PRIVATE_KEY || "").trim();
const OUT_FILE = path.resolve(ROOT, process.env.OUT_FILE || "live-check-results.json");
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT)) { console.error("CONTRACT env must be a 0x address"); process.exit(2); }
if (OWNER_KEY && !/^0x[0-9a-fA-F]{64}$/.test(OWNER_KEY)) { console.error("OWNER_PRIVATE_KEY must be 0x + 64 hex"); process.exit(2); }
const REHEARSAL = !OWNER_KEY;
const METERED = 2; // Jakarta Weather Now, 0.1 GEN per credit
const PAYWALL = 1; // BTC Price Snapshot, 1 GEN once
const PORTS = { registered: 8794, noKey: 8795, unregistered: 8796 };
// Studio's public RPC allows about 30 requests a minute. The checks are paced,
// and the run stops at the first rate-limit answer instead of retrying.
const PAUSE_MS = Number(process.env.PAUSE_MS || 25000);

const { createAccount, createClient } = await import("genlayer-js");
const { studionet } = await import("genlayer-js/chains");
const { TransactionStatus } = await import("genlayer-js/types");

const keys = { gateway: generatePrivateKey(), buyer: generatePrivateKey(), attacker: generatePrivateKey(), stranger: generatePrivateKey() };
const signer = { buyer: privateKeyToAccount(keys.buyer), attacker: privateKeyToAccount(keys.attacker) };
const gatewayAddress = privateKeyToAccount(keys.gateway).address;
const clientFor = (key) => createClient({ chain: studionet, endpoint: RPC_URL, account: createAccount(key) });
const buyerClient = clientFor(keys.buyer);
const reader = buyerClient;

const results = {
  network: "studionet", chainId: 61999, contract: CONTRACT,
  explorer: `https://explorer-studio.genlayer.com/address/${CONTRACT}`,
  mode: REHEARSAL ? "rehearsal (gateway account not registered)" : "live",
  startedAt: new Date().toISOString(),
  accounts: { gateway: gatewayAddress, buyer: signer.buyer.address, attacker: signer.attacker.address },
  transactions: {}, checks: [],
};
const save = () => writeFile(OUT_FILE, JSON.stringify(results, null, 2) + "\n");

async function fund(address, gen) {
  const r = await fetch(RPC_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sim_fundAccount", params: [address, gen * 1e18] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`sim_fundAccount: ${JSON.stringify(j.error).slice(0, 200)}`);
}

async function txInfo(client, hash) {
  const t = await client.getTransaction({ hash });
  return { tx: hash, status: t.statusName, consensus: t.result_name, execution: t.txExecutionResultName };
}

// One fee-aware write, sent once, waited to FINALIZED.
async function write(client, label, functionName, args, value = 0n) {
  let est;
  try {
    est = await client.estimateTransactionFeesForWrite({ address: CONTRACT, functionName, args, value });
  } catch (e) {
    console.log(`  (fee simulation unavailable for ${label}: ${String(e.message).slice(0, 100)}; using the default estimate)`);
    est = await client.estimateTransactionFees();
  }
  const fees = { distribution: est.distribution, feeValue: est.feeValue };
  if (est.messageAllocations) fees.messageAllocations = est.messageAllocations;
  const hash = await client.writeContract({ address: CONTRACT, functionName, args, value, fees });
  console.log(`  ${label}: ${hash}`);
  results.transactions[label] = { tx: hash };
  await save();
  await client.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, retries: 150, interval: 6000 });
  const info = await txInfo(client, hash);
  results.transactions[label] = info;
  await save();
  console.log(`  ${label}: ${info.status} / ${info.consensus} / ${info.execution}`);
  if (info.execution !== "FINISHED_WITH_RETURN") throw new Error(`${label} did not succeed`);
  return hash;
}

const access = async (who, id) => JSON.parse(await reader.readContract({ address: CONTRACT, functionName: "get_access", args: [who, id] }));

// Plain http GET with no client-side timeout (finalization can take minutes).
function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function challenge(port, id, account) {
  const c = await get(port, `/challenge/${id}?buyer=${account.address}`);
  if (c.status !== 200) throw new Error(`challenge failed: ${c.status} ${c.body.slice(0, 200)}`);
  return JSON.parse(c.body);
}
async function signedHeaders(port, id, account, signWith = account) {
  const ch = await challenge(port, id, account);
  return { "X-Buyer": account.address, "X-Nonce": ch.nonce, "X-Signature": await signWith.signMessage({ message: ch.message }) };
}

const looksLikeData = (r) => r.status === 200 && r.body.trim().startsWith("{") && !r.body.includes('"error"');
function summary(r) {
  return {
    http: r.status,
    reason: r.headers["x-gen402-reason"] || null,
    consumptionTx: r.headers["x-gen402-consumption"] || null,
    callsLeftHeader: r.headers["x-gen402-calls-left"] || null,
    dataReleased: looksLikeData(r),
    bodySample: looksLikeData(r) ? r.body.slice(0, 90) : undefined,
  };
}
async function check(name, expect, fn) {
  const entry = { name, expect };
  try {
    const { pass, ...detail } = await fn();
    Object.assign(entry, detail, { pass });
  } catch (e) {
    Object.assign(entry, { pass: false, error: String(e && e.message ? e.message : e).slice(0, 300) });
  }
  results.checks.push(entry);
  await save();
  console.log(`${entry.pass ? "PASS" : "FAIL"}  ${name}${entry.error ? "  — " + entry.error : ""}`);
  if (/rate limit/i.test(JSON.stringify(entry))) throw new Error("Studio RPC rate limit reached; stopping without retrying");
  await new Promise((r) => setTimeout(r, PAUSE_MS));
  return entry;
}

const children = [];
function startGateway(port, gatewayKey) {
  const env = { ...process.env, PORT: String(port), CONTRACT_ADDRESS: CONTRACT, RPC_URL, GATEWAY_ID: `http://127.0.0.1:${port}` };
  delete env.OWNER_PRIVATE_KEY; // the gateway never sees the owner key
  delete env.GATEWAY_PRIVATE_KEY;
  if (gatewayKey) env.GATEWAY_PRIVATE_KEY = gatewayKey;
  const child = spawn(process.execPath, [path.join(ROOT, "gateway", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`    [gw:${port}] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`    [gw:${port}] ${d}`));
  children.push(child);
}
async function waitUp(port) {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await get(port, "/health")).status === 200) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`gateway on ${port} did not start`);
}
const stopAll = () => { for (const c of children) c.kill("SIGTERM"); };
process.on("exit", stopAll);

try {
  console.log(`Mode: ${results.mode}`);
  console.log(`Gateway ${gatewayAddress} · buyer ${signer.buyer.address}`);

  // ---- setup: fund throwaway accounts, register the gateway, buy access
  await fund(gatewayAddress, 10);
  await fund(signer.buyer.address, 10);
  if (!REHEARSAL) {
    const owner = clientFor(OWNER_KEY);
    await write(owner, "set_gateway (owner)", "set_gateway", [gatewayAddress]);
  }
  const buyCreditsTx = await write(buyerClient, "buy_credits(2, 2) (buyer)", "buy_credits", [METERED, 2], 200000000000000000n);
  await write(buyerClient, "buy_access(1) (buyer)", "buy_access", [PAYWALL], 1000000000000000000n);
  results.creditsAfterPurchase = (await access(signer.buyer.address, METERED)).calls_left;
  await save();

  startGateway(PORTS.registered, keys.gateway);
  startGateway(PORTS.noKey, null);
  startGateway(PORTS.unregistered, keys.stranger);
  await Promise.all(Object.values(PORTS).map(waitUp));
  const GW = PORTS.registered;

  // ---- 1. no proof / public tx hash only
  await check("no proof", "402, no data", async () => {
    const r = await get(GW, `/data/${METERED}`);
    return { ...summary(r), pass: r.status === 402 && !looksLikeData(r) };
  });
  await check("impersonation: the buyer's real purchase tx hash + the buyer's address, no signature", "402, no data", async () => {
    const r = await get(GW, `/data/${METERED}`, { "X-Payment": buyCreditsTx, "X-Buyer": signer.buyer.address });
    return { ...summary(r), presentedTx: buyCreditsTx, pass: r.status === 402 && !looksLikeData(r) };
  });
  await check("impersonation: challenge for the buyer signed by another key", "401, no data, no credit used", async () => {
    const before = (await access(signer.buyer.address, METERED)).calls_left;
    const r = await get(GW, `/data/${METERED}`, await signedHeaders(GW, METERED, signer.buyer, signer.attacker));
    const after = (await access(signer.buyer.address, METERED)).calls_left;
    return { ...summary(r), callsLeftBefore: before, callsLeftAfter: after, pass: r.status === 401 && !looksLikeData(r) && before === after };
  });

  // ---- 2. failed consumption paths (credits must stay untouched)
  await check("missing gateway key: metered request to a gateway without a key", "503, no data, no credit used", async () => {
    const before = (await access(signer.buyer.address, METERED)).calls_left;
    const r = await get(PORTS.noKey, `/data/${METERED}`, await signedHeaders(PORTS.noKey, METERED, signer.buyer));
    const after = (await access(signer.buyer.address, METERED)).calls_left;
    return { ...summary(r), callsLeftBefore: before, callsLeftAfter: after, pass: r.status === 503 && !looksLikeData(r) && before === after };
  });
  await check("failed consumption: gateway key that the contract does not recognise", "502, no data, no credit used", async () => {
    const before = (await access(signer.buyer.address, METERED)).calls_left;
    const r = await get(PORTS.unregistered, `/data/${METERED}`, await signedHeaders(PORTS.unregistered, METERED, signer.buyer));
    const after = (await access(signer.buyer.address, METERED)).calls_left;
    return { ...summary(r), callsLeftBefore: before, callsLeftAfter: after, pass: r.status === 502 && !looksLikeData(r) && before === after };
  });

  // ---- 3. signed request: served only after finalized consumption; replay rejected
  let firstProof = null;
  const served = await check("signed request #1 (metered)", REHEARSAL ? "rehearsal: gateway unregistered -> 502, no data" : "200 with data, consumption FINALIZED, credits 2 -> 1", async () => {
    const before = (await access(signer.buyer.address, METERED)).calls_left;
    firstProof = await signedHeaders(GW, METERED, signer.buyer);
    const r = await get(GW, `/data/${METERED}`, firstProof);
    const after = (await access(signer.buyer.address, METERED)).calls_left;
    const s = summary(r);
    const consumption = s.consumptionTx ? await txInfo(reader, s.consumptionTx) : null;
    const pass = REHEARSAL
      ? r.status === 502 && !looksLikeData(r) && before === after
      : looksLikeData(r) && before === 2 && after === 1 && consumption && consumption.status === "FINALIZED" && consumption.execution === "FINISHED_WITH_RETURN";
    return { ...s, callsLeftBefore: before, callsLeftAfter: after, consumption, pass };
  });
  await check("replay: the same nonce and signature again", "401, no data, no credit used", async () => {
    const before = (await access(signer.buyer.address, METERED)).calls_left;
    const r = await get(GW, `/data/${METERED}`, firstProof);
    const after = (await access(signer.buyer.address, METERED)).calls_left;
    return { ...summary(r), callsLeftBefore: before, callsLeftAfter: after, pass: r.status === 401 && !looksLikeData(r) && before === after };
  });

  // ---- 4. two concurrent signed requests, one credit left
  await check("concurrent: two signed requests with 1 credit left", REHEARSAL ? "rehearsal: neither served" : "exactly one served, credits end at 0", async () => {
    const before = (await access(signer.buyer.address, METERED)).calls_left;
    const [h1, h2] = [await signedHeaders(GW, METERED, signer.buyer), await signedHeaders(GW, METERED, signer.buyer)];
    const rs = await Promise.all([get(GW, `/data/${METERED}`, h1), get(GW, `/data/${METERED}`, h2)]);
    const after = (await access(signer.buyer.address, METERED)).calls_left;
    const servedCount = rs.filter(looksLikeData).length;
    const pass = REHEARSAL ? servedCount === 0 && before === after : before === 1 && servedCount === 1 && after === 0;
    return { requests: rs.map(summary), callsLeftBefore: before, callsLeftAfter: after, served: servedCount, pass };
  });
  await check("no credits left: signed request", "402, no data", async () => {
    if (REHEARSAL) return { skipped: "rehearsal: credits were never consumed", pass: true };
    const r = await get(GW, `/data/${METERED}`, await signedHeaders(GW, METERED, signer.buyer));
    const after = (await access(signer.buyer.address, METERED)).calls_left;
    return { ...summary(r), callsLeftAfter: after, pass: r.status === 402 && !looksLikeData(r) && after === 0 };
  });

  // ---- 5. paywall listing with the signed flow
  await check("paywall listing #1: signed request", "200 with data, nothing consumed", async () => {
    const r = await get(GW, `/data/${PAYWALL}`, await signedHeaders(GW, PAYWALL, signer.buyer));
    return { ...summary(r), pass: looksLikeData(r) && !r.headers["x-gen402-consumption"] };
  });
  await check("paywall listing #1: attacker signs their own challenge (no purchase)", "402, no data", async () => {
    const r = await get(GW, `/data/${PAYWALL}`, await signedHeaders(GW, PAYWALL, signer.attacker));
    return { ...summary(r), pass: r.status === 402 && !looksLikeData(r) };
  });
  void served;
} catch (e) {
  results.fatal = String(e && e.message ? e.message : e).slice(0, 400);
  console.error("FATAL:", results.fatal);
} finally {
  stopAll();
  results.finishedAt = new Date().toISOString();
  results.passed = results.checks.filter((c) => c.pass).length;
  results.failed = results.checks.filter((c) => !c.pass).length;
  await save();
  console.log(`\n${results.passed} passed, ${results.failed} failed${results.fatal ? " (fatal: " + results.fatal + ")" : ""} — ${path.basename(OUT_FILE)}`);
  process.exit(results.failed === 0 && !results.fatal ? 0 : 1);
}
