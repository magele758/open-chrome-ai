/**
 * Chrome bundle entry. Import `/mini` only — `.` / `/full` / `/max` pull Node builtins.
 */
export {
  createMiniAssembledLoop,
  createDefaultMemoryStore,
  DEFAULT_EMBED_AGENT,
} from "@mage-ai-lab/agent-loop/mini";
