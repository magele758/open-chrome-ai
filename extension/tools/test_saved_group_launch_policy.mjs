import assert from "node:assert/strict";
import { checkHelperLaunchPolicy } from "../../native/saved-tab-groups.mjs";

const app = "/tmp/PageLens Helper.app";
async function assess({ quarantine = "0081;00000000;Chrome;", signature = "Signature=adhoc", verdict = 3 } = {}) {
  const commands = [];
  const run = async (bin, args) => {
    commands.push(bin);
    assert.equal(args.at(-1), app);
    switch (bin) {
      case "/usr/bin/xattr":
        return { ok: Boolean(quarantine), stdout: quarantine };
      case "/usr/bin/codesign":
        return { ok: true, stderr: signature };
      case "/usr/sbin/spctl":
        assert.deepEqual(args, ["--assess", "--type", "execute", "--no-cache", app]);
        return { ok: verdict === 0, err: verdict ? { code: verdict } : null };
      default:
        throw Error("Assessment must not launch the app");
    }
  };
  return { result: await checkHelperLaunchPolicy(app, run), commands };
}

const blocked = await assess();
assert.equal(blocked.result.code, "HELPER_GATEKEEPER_BLOCKED");
assert.match(blocked.result.hint, /Chrome.*打开.*刷新/);
assert.doesNotMatch(blocked.result.hint, /prepare-helper/);

for (const quarantine of ["", "00c1;00000000;Chrome;", "unexpected format"]) {
  const { result, commands } = await assess({ quarantine });
  assert.equal(result, null);
  assert.deepEqual(commands, ["/usr/bin/xattr"]);
}
assert.equal((await assess({ signature: "Authority=Developer ID Application" })).result, null);
for (const verdict of [0, 1, "ETIMEDOUT"]) assert.equal((await assess({ verdict })).result, null);
console.log("PASS passive assessment of a quarantined local Helper");
