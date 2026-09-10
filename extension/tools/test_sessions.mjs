import {
  MAX_SESSIONS,
  filterSessions,
  formatWhen,
  itemKey,
  mergePage,
  nextIndex,
  normalizeMessage,
  normalizeSession,
  saveSession,
  listSessions,
  loadSession,
  normalizeRun,
  loadAllSessions,
  deleteSession,
  sessionFilename,
  sessionNoteRelPath,
  sessionTitle,
  sessionToMarkdown,
  sessionToObsidianMarkdown,
  sessionsToJSON,
  sessionsToMarkdown,
  toSummary,
} from "../lib/sessions.js";

const bag = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") return { [keys]: bag[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = bag[k];
          return out;
        }
        return { ...bag };
      },
      set: async (obj) => Object.assign(bag, obj),
      remove: async (keys) => {
        for (const k of [].concat(keys)) delete bag[k];
      },
    },
  },
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const pages = mergePage(
  mergePage([], { url: "https://example.com/a", title: "A" }),
  { url: "https://example.com/a", title: "A updated", hostname: "example.com" },
);
assert(pages.length === 1 && pages[0].title === "A updated", "merge page");
assert(pages[0].hostname === "example.com", "hostname");

const msg = normalizeMessage({
  role: "user",
  text: "总结此页",
  image: "data:image/jpeg;base64,xxxxx",
});
assert(msg.hasImage === true && msg.image === undefined, "strip image bytes");

const session = normalizeSession({
  id: "s1",
  createdAt: Date.parse("2026-09-09T04:00:00.000Z"),
  updatedAt: Date.parse("2026-09-09T04:05:00.000Z"),
  pages: [{ url: "https://example.com/x", title: "Hello World", hostname: "example.com" }],
  messages: [
    { role: "user", text: "总结此页", image: "data:image/jpeg;base64,xx" },
    { role: "bot", text: "这是一篇关于 X 的文章。", trace: [{ name: "extract_page", ok: true }] },
  ],
});
assert(session.title === "总结此页", "title from first user line");
assert(sessionTitle({ messages: [], pages: [{ title: "Hello World" }] }) === "Hello World", "title fallback");

const md = sessionToMarkdown(session);
assert(md.includes("https://example.com/x"), "md has url");
assert(md.includes("Hello World"), "md has page title");
assert(md.includes("总结此页"), "md has user");
assert(md.includes("这是一篇关于 X 的文章。"), "md has bot");
assert(md.includes("extract_page"), "md has trace");
assert(md.includes("含截图"), "md notes image");
assert(!md.includes("data:image/jpeg"), "md no image bytes");

const json = sessionsToJSON([session]);
const parsed = JSON.parse(json);
assert(parsed.app === "PageLens" && parsed.sessions[0].id === "s1", "json envelope");
assert(parsed.sessions[0].messages[0].hasImage === true, "json hasImage");
assert(parsed.sessions[0].messages[0].image === undefined, "json no bytes");

assert(sessionFilename(session, "md").endsWith(".md"), "filename ext");
assert(!sessionFilename({ title: "a/b:c", createdAt: Date.now() }, "md").includes("/"), "filename sanitize");

const notePath = sessionNoteRelPath(session);
assert(notePath.startsWith("PageLens/sessions/2026-09-09-总结此页-"), "obsidian path " + notePath);
assert(notePath.endsWith("-s1.md"), "obsidian id suffix " + notePath);
const note = sessionToObsidianMarkdown(session);
assert(note.startsWith("---\n"), "obsidian frontmatter");
assert(note.includes("title: 总结此页"), "obsidian title");
assert(note.includes("tags: [pagelens, session]"), "obsidian tags");
assert(note.includes("session_id: s1"), "obsidian session id");
assert(note.includes("https://example.com/x"), "obsidian url");
assert(note.includes("这是一篇关于 X 的文章。"), "obsidian body");
const quoted = sessionToObsidianMarkdown({
  id: "q1",
  messages: [{ role: "user", text: "标题: 含冒号" }],
});
assert(quoted.includes('title: "标题: 含冒号"'), "yaml quote " + quoted.split("\n")[1]);

const when = formatWhen(Date.now());
assert(when.startsWith("今天 "), "today format: " + when);

const idx = [
  { id: "a", title: "Alpha", pages: [{ hostname: "a.com", url: "https://a.com", title: "A" }] },
  { id: "b", title: "Beta", pages: [{ hostname: "x.com", url: "https://x.com/post", title: "Post" }] },
];
assert(filterSessions(idx, "x.com")[0].id === "b", "filter host");
assert(filterSessions(idx, "Alpha").length === 1, "filter title");
assert(filterSessions(idx, "").length === 2, "empty query");

const grown = nextIndex(
  Array.from({ length: 3 }, (_, i) => ({ id: "old" + i, updatedAt: i })),
  { id: "new", updatedAt: 99 },
  3,
);
assert(grown.length === 3 && grown[0].id === "new" && !grown.some((s) => s.id === "old0"), "prune oldest");
assert(MAX_SESSIONS >= 50, "cap");

const saved = await saveSession({
  id: "live",
  pages: [{ url: "https://news.example/p", title: "News" }],
  messages: [
    { role: "user", text: "这篇在说什么" },
    { role: "bot", text: "在说新闻。" },
  ],
});
assert(saved.title === "这篇在说什么", "save title");
const listed = await listSessions();
assert(listed[0].id === "live" && listed[0].pages[0].url === "https://news.example/p", "index pages");
const loaded = await loadSession("live");
assert(loaded.messages[1].text === "在说新闻。", "load body");
const all = await loadAllSessions();
assert(all.length === 1, "load all");
assert(sessionsToMarkdown(all).includes("news.example"), "export all md");

await saveSession({
  id: "other",
  messages: [{ role: "user", text: "第二场" }, { role: "bot", text: "ok" }],
});
assert((await listSessions()).length === 2, "two sessions");
await deleteSession("live");
assert((await listSessions()).map((s) => s.id).join() === "other", "delete");
assert((await loadSession("live")) === null, "gone");
assert(itemKey("x") === "pl.sessions.item.x", "key");

const summary = toSummary(saved);
assert(summary.messageCount === 2 && summary.pages[0].hostname === "news.example", "summary");

const withRun = await saveSession({
  id: "run1",
  messages: [
    { role: "user", text: "继续" },
    { role: "bot", text: "" },
  ],
  run: {
    status: "running",
    startedAt: Date.now(),
    turnsUsed: 1,
    lastText: "",
    history: [
      { role: "user", content: "继续" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "extract_page", arguments: "{}" } }],
      },
    ],
  },
});
assert(withRun.run?.status === "running" && withRun.run.history[1].tool_calls[0].id === "c1", "persist run");
const loadedRun = await loadSession("run1");
assert(loadedRun.run.turnsUsed === 1, "load run");
assert(!JSON.parse(sessionsToJSON([loadedRun])).sessions[0].run, "export strips run");
assert(
  !normalizeRun({
    status: "running",
    startedAt: Date.now() - 40 * 3600 * 1000,
    history: [{ role: "user", content: "x" }],
  }),
  "stale run dropped",
);

console.log("PASS sessions");
