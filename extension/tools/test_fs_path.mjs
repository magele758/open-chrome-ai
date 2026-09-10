import {
  expandUserPath,
  fileExt,
  isSkillFile,
  looksAbsolutePath,
  parseSkillMeta,
  pathBasename,
  shouldSkipDir,
  splitRelParts,
} from "../lib/fs-path.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(expandUserPath("~", "/Users/me") === "/Users/me", "home");
assert(expandUserPath("~/Notes", "/Users/me") === "/Users/me/Notes", "home slash");
assert(expandUserPath("/tmp/x", "/Users/me") === "/tmp/x", "abs passthrough");
assert(expandUserPath("  ", "/Users/me") === "", "empty");

assert(looksAbsolutePath("/Users/me"), "unix abs");
assert(looksAbsolutePath("C:\\\\Notes") || looksAbsolutePath("C:/Notes"), "win abs");
assert(!looksAbsolutePath("Notes/foo"), "rel");
assert(!looksAbsolutePath("~/Notes"), "tilde not abs");

assert(pathBasename("/Users/me/Notes") === "Notes", "basename");
assert(pathBasename("/Users/me/Notes/") === "Notes", "basename slash");
assert(fileExt("a/b/transcript.md") === "md", "ext");

assert(splitRelParts("yt-x/original.vtt").join("/") === "yt-x/original.vtt", "rel");
let threw = false;
try {
  splitRelParts("../secret");
} catch {
  threw = true;
}
assert(threw, "reject ..");
threw = false;
try {
  splitRelParts("/tmp/x");
} catch {
  threw = true;
}
assert(threw, "reject abs rel");

assert(shouldSkipDir("node_modules") && shouldSkipDir(".git") && isSkillFile("SKILL.md"), "skill helpers");
const meta = parseSkillMeta("---\nname: browse\ndescription: 浏览网页\n---\n# Hi\n");
assert(meta && meta.name === "browse" && /浏览/.test(meta.when), "skill meta");

console.log("PASS fs-path");
