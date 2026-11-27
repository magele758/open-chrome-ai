import assert from "node:assert/strict";
import { interpretTrustCache, planAxLaunch } from "../../native/saved-tab-groups.mjs";

const now = 1_700_000_000_000;

assert.deepEqual(
  planAxLaunch({ action: "open", currentTrusted: true, grantedExists: true, grantedTrusted: true, shimReady: true }),
  { target: "current", mode: "direct", useShim: false },
);
assert.equal(planAxLaunch({ action: "ax_status", currentTrusted: true }).mode, "direct");
assert.equal(planAxLaunch({ action: "request_accessibility", currentTrusted: true }).mode, "direct");
assert.deepEqual(
  planAxLaunch({ action: "open", currentTrusted: false, grantedExists: true, grantedTrusted: true, shimReady: true }),
  { target: "granted", mode: "direct", useShim: true },
);
assert.deepEqual(
  planAxLaunch({ action: "open", currentTrusted: false, grantedExists: true, grantedTrusted: true, shimReady: false }),
  { target: "current", mode: "direct", useShim: false },
);
assert.deepEqual(
  planAxLaunch({ action: "ax_status", grantedExists: true, grantedTrusted: true, shimReady: true }),
  { target: "granted", mode: "direct", useShim: false },
);
assert.equal(planAxLaunch({ action: "open", currentBlocked: true }).mode, "open");
assert.equal(planAxLaunch({ action: "open", currentTrusted: false }).mode, "direct");
assert.equal(planAxLaunch({ action: "open", currentBlocked: true, currentTrusted: true }).mode, "open");

assert.equal(interpretTrustCache({ trusted: false, at: now }, { now }), null);
assert.equal(interpretTrustCache({ trusted: false, at: now, via: "open" }, { now }), null);
assert.equal(interpretTrustCache({ trusted: true, at: now }, { now }), null);
assert.equal(interpretTrustCache({ trusted: true, at: now - 999_999, via: "direct" }, { now }), null);
assert.equal(interpretTrustCache({ trusted: false, at: now, via: "direct" }, { now, refreshStale: false }), null);
assert.equal(interpretTrustCache({ trusted: false, at: now - 59_000, via: "direct" }, { now, refreshStale: true }), null);
assert.equal(interpretTrustCache({ trusted: true, at: now - 999_999, via: "disclaim" }, { now }), true);
assert.equal(interpretTrustCache({ trusted: false, at: now, via: "disclaim" }, { now, refreshStale: false }), false);
assert.equal(interpretTrustCache({ trusted: false, at: now - 59_000, via: "disclaim" }, { now, refreshStale: true }), false);
assert.equal(interpretTrustCache({ trusted: false, at: now - 60_000, via: "disclaim" }, { now, refreshStale: true }), null);
assert.equal(interpretTrustCache(null, { now }), null);

console.log("PASS trusted current helper launches by Mach-O, not open");
