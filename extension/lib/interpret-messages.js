/** Message protocol shared by the panel, service worker and offscreen interpretation host. */
export const INTERPRET_CMD = "pl.interpret.cmd";
export const INTERPRET_HOST = "pl.interpret.host";
export const INTERPRET_EVENT = "pl.interpret.event";
export const INTERPRET_VIDEO = "pl.interpret.video";
export const INTERPRET_NATIVE = "pl.interpret.native";

/** Runtime messages are JSON-serialized: binary payloads would arrive as `{}`. */
export function toMessage(value, depth = 0) {
  if (value == null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (depth > 12) return undefined;
  if ((typeof Blob !== "undefined" && value instanceof Blob) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return undefined;
  if (Array.isArray(value)) return value.map(item => toMessage(item, depth + 1) ?? null);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const next = toMessage(item, depth + 1);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

export const isActiveState = state => state?.fsmState === "running" || state?.fsmState === "preparing";
