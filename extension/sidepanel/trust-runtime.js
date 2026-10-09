import { createDelegatePanel } from "./delegate-panel.js";
import { state } from "./state.js";
import { createTrustPanel } from "./trust-panel.js";
import { DELEGATE_STORAGE_KEY } from "../lib/agent/delegate.js";
import { chromeStorageAdapter, createApprovalQueue } from "../lib/agent/trust/approval-queue.js";
import { debugLog } from "../lib/debug-log.js";

const approvalQueue = createApprovalQueue({ storage: chromeStorageAdapter() });
const trustPanel = createTrustPanel({
  getCapsule: () => state.capsule,
  setCapsule: (capsule) => {
    state.capsule = capsule;
    debugLog("trust.capsule.widen", { actions: capsule.actions, origins: capsule.origins, commands: capsule.commands.length });
  },
  getTaint: () => state.taint,
  approvals: approvalQueue,
});
const delegatePanel = createDelegatePanel({
  load: async () => (await chrome.storage.session.get(DELEGATE_STORAGE_KEY))?.[DELEGATE_STORAGE_KEY] || [],
  cancel: (taskId) => chrome.runtime.sendMessage({ type: "pl.delegate.cancel", taskId }),
});


export {
  approvalQueue,
  trustPanel,
  delegatePanel,
};
