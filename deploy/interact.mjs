// Interact with a deployed Gen402 contract on studionet: buy paywall access
// to listing #1 and run the AI delivery verification, then read back state.
// Usage:
//   CONTRACT=0x... PRIVATE_KEY=0x<throwaway studionet key> node deploy/interact.mjs
// PRIVATE_KEY must be a throwaway test key. It is only read from the
// environment and never printed or written anywhere by this script.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RPC_URL = process.env.RPC_URL || "https://studio.genlayer.com/api";
const CONTRACT = (process.env.CONTRACT || "").trim();
const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT)) { console.error("CONTRACT env must be a 0x address"); process.exit(2); }
if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) { console.error("PRIVATE_KEY env must be a 0x + 64 hex throwaway key"); process.exit(2); }

const { createAccount, createClient } = await import("genlayer-js");
const { studionet } = await import("genlayer-js/chains");
const { TransactionStatus } = await import("genlayer-js/types");

const account = createAccount(PRIVATE_KEY);
console.log("Account:", account.address);
const client = createClient({ chain: studionet, endpoint: RPC_URL, account });
const out = { network: "studionet", chainId: 61999, rpc: RPC_URL, contractAddress: CONTRACT, account: account.address, explorer: `https://explorer-studio.genlayer.com/address/${CONTRACT}`, steps: {} };

async function wait(hash, label) {
  console.log(`  waiting for ${label}: ${hash}`);
  try {
    await client.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, retries: 120, interval: 5000 });
    console.log(`  ${label} FINALIZED`);
    return true;
  } catch (e) {
    console.log(`  ${label} wait timed out: ${e.message}`);
    return false;
  }
}

// 1 GEN in wei, listing #1 price
const buyHash = await client.writeContract({
  address: CONTRACT, functionName: "buy_access", args: [1], value: 1000000000000000000n,
});
await wait(buyHash, "buy_access #1 (1 GEN)");
out.steps.buyAccess1 = buyHash;

const verifyHash = await client.writeContract({
  address: CONTRACT, functionName: "verify_delivery", args: [1], value: 0n,
});
const finalized = await wait(verifyHash, "verify_delivery #1 (AI consensus)");
out.steps.verifyDelivery1 = verifyHash;
out.steps.verifyDelivery1Finalized = finalized;

out.reads = {
  hasAccess: await client.readContract({ address: CONTRACT, functionName: "has_access", args: [account.address, 1] }),
  verdict1: await client.readContract({ address: CONTRACT, functionName: "get_verdict", args: [1] }),
  sellerBalance: String(await client.readContract({ address: CONTRACT, functionName: "seller_balance", args: [account.address] })),
  listings: JSON.parse(await client.readContract({ address: CONTRACT, functionName: "list_listings", args: [] })),
};
console.log("Reads:", JSON.stringify(out.reads, null, 2));

let existing = {};
try { existing = JSON.parse(await readFile(path.join(ROOT, "deployment.json"), "utf-8")); } catch { /* first run */ }
await writeFile(path.join(ROOT, "deployment.json"), JSON.stringify({ ...existing, ...out }, null, 2));
console.log("Wrote deployment.json");
