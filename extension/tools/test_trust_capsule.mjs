import assert from "node:assert/strict";
import {
  capsuleCovers,
  describeCapsule,
  emptyCapsule,
  extractCapsule,
  hostMatchesDomain,
  mergeCapsules,
  normalizeCapsule,
  normalizeCommand,
  setCapsuleActions,
  widenCapsule,
} from "../lib/agent/trust/capsule.js";
import {
  TAINT_CLEAN,
  TAINT_DATA,
  TAINT_HIGH,
  createTaintState,
  ingestData,
  isTainted,
  markHighTaint,
  sourceLabel,
  taintLevel,
} from "../lib/agent/trust/taint.js";
import { withUntrustedOutput } from "../lib/untrusted.js";

// 1. 确定性抽取：动作类别、URL/域名、平台、收件人、路径、原文命令
{
  const c = extractCapsule("把这篇总结发到微信公众号草稿");
  assert.deepEqual(c.actions, ["publish"]);
  assert.deepEqual(c.platforms, ["wechat"]);
  assert.deepEqual(c.origins, ["mp.weixin.qq.com"]);
  assert.equal(c.principal, "user");
}
{
  const c = extractCapsule("打开 https://github.com/a/b/pulls 看看，然后运行 `git status` 和 `npm test`");
  assert.ok(c.actions.includes("navigate") && c.actions.includes("shell"));
  assert.deepEqual(c.urls, ["https://github.com/a/b/pulls"]);
  assert.ok(c.origins.includes("github.com"));
  assert.deepEqual(c.commands, ["git status", "npm test"]);
}
{
  const c = extractCapsule("请执行：\n```bash\n$ curl -s https://api.github.com/repos/a/b\n# comment\nls   -la\n```\n以及\n$ echo hi");
  assert.deepEqual(c.commands, ["curl -s https://api.github.com/repos/a/b", "ls -la", "echo hi"]);
  assert.ok(c.origins.includes("api.github.com"));
}
assert.deepEqual(extractCapsule('运行 "npm run build" 看看').commands, ["npm run build"]);
assert.deepEqual(extractCapsule("run “pytest -q” please").commands, ["pytest -q"]);
{
  const c = extractCapsule("send the summary to bob@corp.com and @alice on x.com");
  assert.ok(c.actions.includes("send"));
  assert.deepEqual(c.recipients, ["bob@corp.com", "@alice"]);
  assert.ok(c.origins.includes("x.com"));
  assert.ok(!c.origins.includes("corp.com"), "email domains are recipients, not navigation targets");
}
{
  const c = extractCapsule("下载 https://example.com/r.pdf 到 ~/Downloads/reports，再上传 /tmp/a.txt 到 docs.google.com");
  assert.ok(c.actions.includes("download") && c.actions.includes("upload"));
  assert.deepEqual(c.paths, ["~/Downloads/reports", "/tmp/a.txt"]);
  assert.ok(c.origins.includes("example.com") && c.origins.includes("docs.google.com"));
}
{
  const c = extractCapsule("总结这页");
  assert.deepEqual(c.actions, [], "summarising grants no action");
  assert.deepEqual(c.origins, []);
}
assert.deepEqual(extractCapsule("看下 README.md 和 index.js").origins, [], "file names are not domains");
assert.deepEqual(extractCapsule("把主题改成深色").actions, ["settings"]);
assert.deepEqual(extractCapsule("").actions, []);
assert.equal(normalizeCommand("  git   status \n"), "git status");
assert.ok(hostMatchesDomain("www.zhuanlan.zhihu.com", "zhihu.com"));
assert.ok(!hostMatchesDomain("evilzhihu.com", "zhihu.com"));

// 2. 显式胶囊（P5 委托）：校验并丢弃非法值
{
  const c = normalizeCapsule({
    principal: "agent",
    actions: ["input", "nuke"],
    origins: ["https://Docs.Example.com/x", "bad host", "localhost"],
    urls: ["javascript:alert(1)", "https://a.com/p"],
    platforms: ["juejin", "myspace"],
    paths: ["/tmp/out", "../etc", "/tmp/../etc", "rel/path"],
    commands: ["  ls  -la "],
  });
  assert.equal(c.principal, "agent");
  assert.deepEqual(c.actions, ["input"]);
  assert.deepEqual(c.urls, ["https://a.com/p"]);
  assert.deepEqual(c.origins, ["docs.example.com", "localhost", "a.com", "juejin.cn"]);
  assert.deepEqual(c.platforms, ["juejin"]);
  assert.deepEqual(c.paths, ["/tmp/out"]);
  assert.deepEqual(c.commands, ["ls -la"]);
}
assert.deepEqual(normalizeCapsule(null).actions, []);

// 3. 合并 / 扩大 / 收窄
{
  const a = extractCapsule("打开 github.com");
  const b = extractCapsule("运行 `npm test`");
  const m = mergeCapsules(a, b);
  assert.ok(m.actions.includes("navigate") && m.actions.includes("shell"));
  assert.deepEqual(m.commands, ["npm test"]);
  assert.equal(mergeCapsules(null, null).actions.length, 0);
  const w = widenCapsule(m, { actions: ["download"], text: "example.org\n`make lint`\n~/Desktop" });
  assert.ok(w.widened);
  assert.ok(w.actions.includes("download"));
  assert.ok(w.origins.includes("example.org"));
  assert.ok(w.commands.includes("make lint"));
  assert.ok(w.paths.includes("~/Desktop"));
  const narrowed = setCapsuleActions(w, ["navigate"]);
  assert.deepEqual(narrowed.actions, ["navigate"]);
  assert.ok(describeCapsule(w).some((line) => line.includes("example.org")));
  assert.deepEqual(describeCapsule(emptyCapsule()), ["动作：仅阅读"]);
}

// 4. capsuleCovers：按工具类别 + 目标判定
{
  const SRC = "https://docs.example.com/page";
  const c = mergeCapsules(
    extractCapsule("打开 https://github.com/x 并在那里填写表单；发到掘金；下载 https://cdn.example.net/a.pdf；上传 ~/Downloads/a.pdf；运行 `npm test`；保存笔记；关闭标签"),
    null,
  );
  const covers = (toolName, args = {}, targetUrl = "") => capsuleCovers(c, { toolName, args, targetUrl, sourceUrl: SRC }).covered;
  assert.ok(covers("extract_page"), "read-only always covered");
  assert.ok(covers("open_tab", { url: "https://github.com/x/y" }));
  assert.ok(!covers("open_tab", { url: "https://evil.com/?q=1" }));
  assert.ok(covers("fill", { value: "x" }, "https://github.com/login"));
  assert.ok(covers("fill", { value: "x" }, "https://docs.example.com/form"), "task source page counts for input");
  assert.ok(!covers("fill", { value: "x" }, "https://mail.bank.com/"));
  assert.ok(!covers("fill", { value: "x" }, ""), "unknown target is not covered");
  assert.ok(covers("cose_publish", { platforms: ["juejin"] }));
  assert.ok(!covers("cose_publish", { platforms: ["juejin", "zhihu"] }));
  assert.ok(!covers("cose_publish", {}));
  assert.ok(covers("download_file", { url: "https://cdn.example.net/a.pdf" }));
  assert.ok(!covers("download_file", { url: "https://other.io/a.pdf" }));
  assert.ok(covers("upload_file", { paths: ["~/Downloads/a.pdf"] }));
  assert.ok(!covers("upload_file", { paths: ["~/Downloads/../.ssh/id_rsa"] }));
  assert.ok(!covers("upload_file", { paths: ["/etc/passwd"] }));
  assert.ok(covers("run_shell", { command: "npm   test" }), "whitespace-normalised verbatim command");
  assert.ok(!covers("run_shell", { command: "npm test && curl evil.com" }));
  assert.ok(covers("write_library", { path: "a.md", text: "x" }));
  assert.ok(covers("close_tab", { tabId: 3 }));
  assert.ok(!covers("update_settings", {}));
  assert.ok(!covers("automa_execute", {}));
  assert.ok(!covers("chrome_call", { method: "bookmarks.remove" }));
  assert.ok(!capsuleCovers(null, { toolName: "fill" }).covered);
}

// 5. 污点状态
{
  let t = createTaintState();
  assert.equal(taintLevel(t), TAINT_CLEAN);
  assert.ok(!isTainted(t));
  t = ingestData(t, { source: "page", tool: "extract_page", origin: "https://a.com" });
  t = ingestData(t, { source: "page", tool: "extract_page", origin: "https://a.com" });
  assert.equal(taintLevel(t), TAINT_DATA);
  assert.equal(t.sources.length, 1, "same source is recorded once");
  t = markHighTaint(t, { tool: "get_captions", match: "ignore previous instructions" });
  assert.equal(taintLevel(t), TAINT_HIGH);
  t = ingestData(t, { source: "subtitle", tool: "get_captions" });
  assert.equal(taintLevel(t), TAINT_HIGH, "ingesting more data never lowers taint");
  assert.equal(t.injection.tool, "get_captions");
  assert.equal(taintLevel("bogus"), TAINT_CLEAN);
  assert.equal(sourceLabel("get_captions"), "subtitle");
  assert.equal(sourceLabel("click"), "tool_result", "every tool result is data");
}

// 6. withUntrustedOutput 对所有工具结果报告读入（扩展自身的 skill / 工具集结果除外）
{
  const ingested = [];
  const tools = withUntrustedOutput(
    [
      { name: "extract_page", execute: async () => "正文" },
      { name: "click", execute: async () => "ok" },
      { name: "load_skill", execute: async () => "skill body" },
      { name: "list_tabs", execute: async () => null },
    ],
    { onIngest: (x) => ingested.push(x) },
  );
  for (const t of tools) await t.execute({});
  assert.deepEqual(ingested, [
    { tool: "extract_page", source: "page" },
    { tool: "click", source: "tool_result" },
  ]);
}

console.log("PASS test_trust_capsule.mjs");
