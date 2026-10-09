import { DEBUG_BUILD, debugLog, hydrateDebugLog } from "../lib/debug-log.js";

hydrateDebugLog();
debugLog("panel.loaded", { build: DEBUG_BUILD, source: "sidepanel" });

console.info("[pagelens] module start");
