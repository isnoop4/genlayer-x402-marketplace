import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { readFileSync } from "node:fs";
const key = readFileSync("/home/hatch/.genlayer/gen402-deploy.key", "utf-8").trim();
const account = createAccount(key);
const client = createClient({ chain: studionet, endpoint: "https://studio.genlayer.com/api", account });
const CONTRACT = "0x097B786EB45d630826f9814b87894bDA8Bddf77B";
// 10 credits x 0.1 GEN = 1 GEN
const hash = await client.writeContract({ address: CONTRACT, functionName: "buy_credits", args: [2, 10], value: 1000000000000000000n });
console.log("buy_credits tx:", hash);
const receipt = await client.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, retries: 60, interval: 5000 });
console.log("FINALIZED");
const access = await client.readContract({ address: CONTRACT, functionName: "get_access", args: [account.address, 2] });
console.log("access #2:", access);
