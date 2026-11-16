import { INTERPRET_CMD } from "../lib/interpret-messages.js";
import { runPlannedInterpret } from "../lib/planned-interpret.js";

// Chrome releases this origin-wide lock even if the panel closes mid-sentence.
export function runCompactGeneration(options) {
  const lease = "pagelens-compact:" + crypto.randomUUID();
  return navigator.locks.request(lease, { signal: options.signal }, async () => {
    const stop = new AbortController();
    const cancel = msg => {
      if (msg?.type === "pl.compact.cancel" && msg.lease === lease) stop.abort();
    };
    chrome.runtime.onMessage.addListener(cancel);
    try {
      const result = await chrome.runtime.sendMessage({ type: INTERPRET_CMD, op: "compactClaim", lease,
        tab: { id: options.tabId, url: options.sourceUrl, title: options.title } });
      if (!result?.ok) throw Error(result?.error || "无法接管音频任务");
      return await runPlannedInterpret({ ...options, generateFull: true,
        signal: AbortSignal.any([options.signal, stop.signal]) });
    } finally { chrome.runtime.onMessage.removeListener(cancel); }
  });
}
