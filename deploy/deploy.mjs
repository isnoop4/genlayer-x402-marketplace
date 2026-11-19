// Deploy Gen402 to GenLayer studionet (chain 61999) and seed it.
// Usage:
//   PRIVATE_KEY=0x<throwaway studionet key> node deploy/deploy.mjs
// The key must be a FRESH throwaway test key. Never use a real/mainnet key.
// What it does:
//   1. deploys contracts/marketplace.py
//   2. creates the 3 listings from data/listings.json
//   3. buys paywall access to listing #1 (1 GEN)
//   4. calls verify_delivery(1) (AI verdict; consensus can take minutes —
//      if it times out the script records it as pending and exits 0 with
//      deployment.json still written)
// Output: deployment.json in the repo root.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RPC_URL = process.env.RPC_URL || "https://studio.genlayer.com/api";
const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
  console.error("PRIVATE_KEY env must be a 0x + 64 hex throwaway studionet key.");
  process.exit(2);
}

const { createAccount, createClient } = await import("genlayer-js");
const { studionet } = await import("genlayer-js/chains");
const { TransactionStatus } = await import("genlayer-js/types");

const account = createAccount(PRIVATE_KEY);
console.log("Deployer:", account.address);
const client = createClient({ chain: studionet, endpoint: RPC_URL, account });
const out = { network: "studionet", chainId: 61999, rpc: RPC_URL, deployer: account.address, steps: {} };

async function wait(hash, label) {
  console.log(`  waiting for ${label}: ${hash}`);
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash, status: TransactionStatus.FINALIZED, retries: 90, interval: 5000,
    });
    console.log(`  ${label} FINALIZED`);
    return receipt;
  } catch (e) {
    console.log(`  ${label} wait timed out (tx may still finalize): ${e.message}`);
    return null;
  }
}

const code = await readFile(path.join(ROOT, "contracts", "marketplace.py"), "utf-8");
console.log("Deploying marketplace.py …");
const deployResult = await client.deployContract({ code, args: [] });
console.log("deployContract returned:", deployResult);
// deployContract returns the contract address in current genlayer-js; if it
// ever returns a tx hash instead, the receipt below reveals the address.
let contract = deployResult;
if (deployResult.length === 66) {
  await wait(deployResult, "deploy");
  // genlayer-js deployContract returns the deploy tx hash, and the receipt
  // it returns has no contractAddress on studionet. The Ghost / Intelligent
  // Contract address is the tx's `to`, so resolve it from the raw receipt.
  const raw = await fetch(RPC_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [deployResult], id: 1 }),
  }).then((r) => r.json());
  const cand = raw?.result?.to;
  if (!cand) throw new Error("could not resolve contract address from deploy receipt");
  contract = cand;
}
out.contractAddress = contract;
out.explorer = `https://explorer-studio.genlayer.com/address/${contract}`;
console.log("Contract:", contract, out.explorer);

const listings = JSON.parse(await readFile(path.join(ROOT, "data", "listings.json"), "utf-8"));
out.listings = [];
for (const l of listings) {
  const hash = await client.writeContract({
    address: contract, functionName: "create_listing",
    args: [l.title, l.description, l.data_url, l.model, BigInt(l.price_wei)],
    value: 0n,
  });
  await wait(hash, `create_listing #${l.id} (${l.title})`);
  out.listings.push({ id: l.id, title: l.title, tx: hash });
}

const paywall = listings[0];
const buyHash = await client.writeContract({
  address: contract, functionName: "buy_access", args: [paywall.id],
  value: BigInt(paywall.price_wei),
});
await wait(buyHash, "buy_access #1");
out.steps.buyAccess1 = buyHash;

try {
  const verifyHash = await client.writeContract({
    address: contract, functionName: "verify_delivery", args: [1], value: 0n,
  });
  const receipt = await wait(verifyHash, "verify_delivery #1");
  out.steps.verifyDelivery1 = verifyHash;
  out.steps.verifyDelivery1Receipt = receipt ? "FINALIZED" : "PENDING (check later)";
} catch (e) {
  out.steps.verifyDelivery1 = `FAILED: ${e.message}`;
}

await writeFile(path.join(ROOT, "deployment.json"), JSON.stringify(out, null, 2));
console.log("Wrote deployment.json");
console.log(JSON.stringify(out, null, 2));
