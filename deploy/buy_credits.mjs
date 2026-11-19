// Buy metered credits for a listing on an already-deployed Gen402 contract.
// Usage:
//   CONTRACT=0x... PRIVATE_KEY=0x<testnet key> node deploy/buy_credits.mjs [credits]
// Defaults: 10 credits for listing #2 (0.1 GEN each = 1 GEN).
// The key is only read from the environment and never printed or written
// anywhere by this script.
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const RPC_URL = process.env.RPC_URL || "https://studio.genlayer.com/api";
const CONTRACT = (process.env.CONTRACT || "").trim();
const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT)) { console.error("CONTRACT env must be a 0x address"); process.exit(2); }
if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) { console.error("PRIVATE_KEY env must be a 0x + 64 hex testnet key"); process.exit(2); }
const credits = Number(process.argv[2] || 10);

const account = createAccount(PRIVATE_KEY);
console.log("Account:", account.address);
const client = createClient({ chain: studionet, endpoint: RPC_URL, account });
// 10 credits x 0.1 GEN = 1 GEN
const hash = await client.writeContract({ address: CONTRACT, functionName: "buy_credits", args: [2, credits], value: BigInt(credits) * 100000000000000000n });
console.log("buy_credits tx:", hash);
await client.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, retries: 60, interval: 5000 });
console.log("FINALIZED");
const access = await client.readContract({ address: CONTRACT, functionName: "get_access", args: [account.address, 2] });
console.log("access #2:", access);
