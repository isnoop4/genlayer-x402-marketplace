// Signed request against a Gen402 gateway: challenge -> sign -> data.
// Usage:
//   BUYER_PRIVATE_KEY=0x<key of the account that bought access> \
//     node gateway/client.mjs <gateway url> <listing id>
// The key is read from the environment only, used to sign the gateway's
// challenge locally, and never sent, printed or written anywhere.
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

export async function signedRequest(baseUrl, listingId, signer) {
  const c = await fetch(`${baseUrl}/challenge/${listingId}?buyer=${signer.address}`);
  const challenge = await c.json();
  if (!c.ok) return { status: c.status, reason: challenge.error, body: challenge };
  const signature = await signer.signMessage({ message: challenge.message });
  const r = await fetch(`${baseUrl}/data/${listingId}`, {
    headers: { "X-Buyer": signer.address, "X-Nonce": challenge.nonce, "X-Signature": signature },
  });
  return {
    status: r.status,
    reason: r.headers.get("x-gen402-reason"),
    consumption: r.headers.get("x-gen402-consumption"),
    callsLeft: r.headers.get("x-gen402-calls-left"),
    body: await r.text(),
    challenge, signature,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base = "http://localhost:8787", idArg = "1"] = process.argv.slice(2);
  const key = (process.env.BUYER_PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) { console.error("BUYER_PRIVATE_KEY env must be 0x + 64 hex"); process.exit(2); }
  const account = privateKeyToAccount(key);
  const id = Number(idArg);
  const out = await signedRequest(base.replace(/\/$/, ""), id, account);
  console.log(`buyer ${account.address} · listing #${id} · HTTP ${out.status}`);
  if (out.reason) console.log(`reason: ${out.reason}`);
  if (out.consumption) console.log(`consumption tx: ${out.consumption} (calls left: ${out.callsLeft ?? "?"})`);
  console.log(typeof out.body === "string" ? out.body.slice(0, 2000) : JSON.stringify(out.body, null, 2));
}
