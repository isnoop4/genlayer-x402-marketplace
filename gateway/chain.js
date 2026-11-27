// Gen402 gateway — studionet adapter (genlayer-js 2.x, fee-aware writes).
// Kept apart from core.js so the access logic can be tested with a fake chain.
//
// Studionet charges protocol fees (Consensus v0.6): every write carries a fee
// deposit, and an account with no GEN cannot write at all. The gateway account
// therefore needs a small GEN balance.

const OK_CONSENSUS = new Set(["MAJORITY_AGREE", "AGREE"]);

export async function createStudionetChain({ rpcUrl, contractAddress, gatewayPrivateKey, finalizeRetries = 100, finalizeIntervalMs = 6000, log = () => {} }) {
  const sdk = await import("genlayer-js");
  const { studionet } = await import("genlayer-js/chains");

  let account = null;
  const config = { chain: studionet, endpoint: rpcUrl };
  if (gatewayPrivateKey) {
    account = sdk.createAccount(gatewayPrivateKey.startsWith("0x") ? gatewayPrivateKey : `0x${gatewayPrivateKey}`);
    config.account = account;
  }
  const client = sdk.createClient(config);

  const read = (functionName, args = []) => client.readContract({ address: contractAddress, functionName, args });

  async function feesFor(functionName, args, value = 0n) {
    const est = await client.estimateTransactionFeesForWrite({ address: contractAddress, functionName, args, value });
    const fees = { distribution: est.distribution, feeValue: est.feeValue };
    if (est.messageAllocations) fees.messageAllocations = est.messageAllocations;
    return fees;
  }

  // Poll until the transaction is FINALIZED. A failed poll (RPC hiccup, rate
  // limit) is not an outcome: keep waiting until the deadline. Only a
  // FINALIZED transaction with a successful execution result counts.
  async function finalizedOutcome(hash) {
    let last = null;
    for (let i = 0; i < finalizeRetries; i += 1) {
      await new Promise((r) => setTimeout(r, finalizeIntervalMs));
      let t;
      try { t = await client.getTransaction({ hash }); } catch { continue; }
      last = t;
      if (t.statusName === "FINALIZED" || t.statusName === "CANCELED" || t.statusName === "UNDETERMINED") break;
    }
    if (!last) throw new Error("no status could be read");
    const finalized = last.statusName === "FINALIZED";
    const success = finalized && last.txExecutionResultName === "FINISHED_WITH_RETURN" && OK_CONSENSUS.has(last.result_name);
    return {
      finalized, success, status: last.statusName, execution: last.txExecutionResultName, consensus: last.result_name,
    };
  }

  async function accessRecord(buyer, listingId) {
    return JSON.parse(await read("get_access", [buyer, listingId]));
  }

  return {
    client,
    gatewayAddress: account ? account.address : null,
    canConsume: () => account !== null,
    read,
    hasAccess: (buyer, listingId) => read("has_access", [buyer, listingId]),
    accessRecord,

    // Consume one call for `buyer` and report only what the chain confirms.
    async consumeCall(listingId, buyer) {
      if (!account) return { finalized: false, success: false, reason: "no gateway key configured" };
      // Studio simulates this exact call first. If the simulation fails the
      // call would revert (no calls left, refunded, gateway not registered),
      // so nothing is sent and nothing is released.
      let fees;
      try {
        fees = await feesFor("use_call", [listingId, buyer]);
      } catch (e) {
        let noCredits = false;
        try {
          const rec = await accessRecord(buyer, listingId);
          noCredits = !rec.unlimited && (rec.refunded || Number(rec.calls_left) <= 0);
        } catch { /* keep noCredits false: unknown */ }
        return {
          finalized: false, success: false, noCredits,
          reason: noCredits ? "no calls left for this buyer" : `use_call simulation failed (${String(e.message).slice(0, 140)})`,
        };
      }
      const hash = await client.writeContract({ address: contractAddress, functionName: "use_call", args: [listingId, buyer], value: 0n, fees });
      log(`use_call(${listingId}, ${buyer}) sent: ${hash}`);
      let outcome;
      try {
        outcome = await finalizedOutcome(hash);
      } catch (e) {
        return { finalized: false, success: false, hash, reason: `use_call ${hash} could not be confirmed (${String(e.message).slice(0, 100)})` };
      }
      if (!outcome.finalized) {
        return { ...outcome, success: false, hash, reason: `use_call ${hash} is ${outcome.status}, not FINALIZED` };
      }
      if (!outcome.success) {
        return { ...outcome, hash, reason: `use_call ${hash} ended ${outcome.status} / ${outcome.execution} / ${outcome.consensus}` };
      }
      let callsLeft = null;
      try { callsLeft = Number((await accessRecord(buyer, listingId)).calls_left); } catch { /* informational only */ }
      return { ...outcome, hash, callsLeft };
    },

    // Used by POST /verify/:id (the gateway pays the fee).
    async verifyDelivery(listingId) {
      if (!account) throw new Error("no gateway key configured");
      const fees = await feesFor("verify_delivery", [listingId]);
      return client.writeContract({ address: contractAddress, functionName: "verify_delivery", args: [listingId], value: 0n, fees });
    },
  };
}
