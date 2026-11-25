import { repairDraftRequest } from "../extension/skills/tiktok-mx-draft/tiktok-mx-native.mjs";
import { mxSellerRequest } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";

// One unpacked extension task per Chrome Native Messaging port.
export function draftPort(write) {
  let started = false, next = 0, closed = false;
  const pending = new Map();
  function request(job) {
    if (closed) return Promise.reject(Error("Draft port disconnected"));
    const seq = ++next;
    return new Promise((resolve, reject) => {
      pending.set(seq, { resolve, reject });
      write({ type: "mx.tool", seq, job });
    });
  }
  return {
    async start(message) {
      if (started) throw Error("Draft task already started");
      started = true;
      if (message.type === "mx.seller") {
        const parameters = mxSellerRequest(message.request);
        const { runMxSellerAction } = await import("./mx-ptc-seller.mjs");
        return runMxSellerAction(parameters, request);
      }
      if (message.type === "mx.repair") {
        const parameters = repairDraftRequest(message);
        const { repairHostedDraft } = await import("./mx-ptc-repair.mjs");
        return repairHostedDraft(parameters, request);
      }
      const { sourceId, rate } = message;
      const { createHostedDraft } = await import("../tools/tiktok-mx-draft.mjs");
      const { inspectWithPtc } = await import("./mx-ptc-inspect.mjs");
      const { dir, receipt } = await createHostedDraft(sourceId, rate, request);
      const audit = await inspectWithPtc({ sourceId, draftId: receipt.id }, async () => receipt.readback);
      return { ...audit, runtime: "pagelens-native", receiptFile: dir + "/receipt.json", stages: receipt.stages,
        skuWrites: receipt.skuWrites, firstRefreshMatched: receipt.firstPersisted.matched,
        elapsedSeconds: receipt.elapsedSeconds, browserCalls: next };
    },
    reply(msg) {
      const call = pending.get(msg.seq);
      if (!call) return;
      pending.delete(msg.seq);
      if (msg.ok) call.resolve(msg.result);
      else call.reject(Error(msg.error || "Extension tool failed"));
    },
    close() {
      closed = true;
      for (const call of pending.values()) call.reject(Error("Draft port disconnected"));
      pending.clear();
    },
  };
}
