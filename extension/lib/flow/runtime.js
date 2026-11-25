import { shopeeProductListing } from "../../flows/shopee/product-listing/definition.js";

const flows = new Map([shopeeProductListing].map((flow) => [flow.id, flow]));

export function listFlows() {
  return [...flows.values()].map(({ matchesTarget: _matchesTarget, replay: _replay, ...meta }) => meta);
}

export function matchesFlowTarget(flowId, url, shopId) {
  const flow = flows.get(flowId);
  return Boolean(flow && url && flow.matchesTarget(url, shopId));
}

export async function runFlow({ flowId, tabId, input, call, onStep, signal, registerRecovery }) {
  const flow = flows.get(flowId);
  if (!flow) throw new Error("找不到工作流：" + flowId);
  const replay = () => flow.replay({ call, tabId, input, onStep, signal, registerRecovery });
  const locks = globalThis.navigator?.locks;
  if (!locks) return replay();
  return locks.request(`pagelens-flow:${tabId}`, { ifAvailable: true }, (lock) => lock
    ? replay()
    : { status: "needs-review", step: "bind-page", code: "flow-busy", completed: [], elapsedMs: 0 });
}
