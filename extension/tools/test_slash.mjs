import { systemPrompt, visibleSkills } from "../lib/prompts.js";
import { defaultSettings, isSkillsEnabled } from "../lib/storage.js";
import {
  applySlashItem,
  composeSkillPrompt,
  filterSlashItems,
  mentionedSkills,
  parseSlashToken,
  skillCommandText,
  slashItemsFromSkills,
  userInvokedSkill,
} from "../lib/slash.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const skills = [
  { id: "find-skills", name: "find-skills", when: "帮用户找现成 skill", body: "去目录里搜" },
  { id: "gstack/browse", name: "browse", when: "浏览网页", body: "打开浏览器" },
  { id: "long-one", name: "long-one", when: "很长", body: "x".repeat(13000) },
];

assert(skillCommandText(skills[1]) === "使用 browse skill", "command text");
assert(slashItemsFromSkills(skills).length === 3, "items");
assert(slashItemsFromSkills([]).length === 0, "empty items");
assert(slashItemsFromSkills(skills)[1].insert === "使用 browse skill", "insert");

assert(parseSlashToken("", 0) === null, "empty");
assert(parseSlashToken("hello", 5) === null, "plain");
assert(parseSlashToken("https://x.com", 13) === null, "url");
const lone = parseSlashToken("/", 1);
assert(lone && lone.start === 0 && lone.query === "", "lone slash");
const mid = parseSlashToken("先看 /br", 6);
assert(mid && mid.query === "br" && mid.start === 3, "mid token " + JSON.stringify(mid));
const nested = parseSlashToken("/gstack/browse", 14);
assert(nested && nested.query === "gstack/browse", "nested");
assert(parseSlashToken("foo /bar baz", 12) === null, "after token");
assert(parseSlashToken("hello\n/", 7)?.query === "", "newline");

const items = slashItemsFromSkills(skills);
assert(filterSlashItems(items, "").length === 3, "all");
assert(filterSlashItems(items, "browse")[0].id === "gstack/browse", "name/id");
assert(filterSlashItems(items, "gst")[0].id === "gstack/browse", "prefix");
assert(filterSlashItems(items, "找现成")[0].id === "find-skills", "hint");
assert(filterSlashItems(items, "zzz").length === 0, "miss");

const applied = applySlashItem("先看 /br 这页", mid, items[1]);
assert(applied.text === "先看 使用 browse skill 这页", "apply rest " + applied.text);
assert(applied.cursor === "先看 使用 browse skill ".length, "cursor");
const only = applySlashItem("/", lone, items[0]);
assert(only.text === "使用 find-skills skill ", "apply lone");

assert(mentionedSkills("使用 browse skill 总结", skills)[0].id === "gstack/browse", "mention name");
assert(mentionedSkills("使用 gstack/browse skill", skills)[0].id === "gstack/browse", "mention id");
assert(mentionedSkills("随便问问", skills).length === 0, "no mention");

assert(userInvokedSkill("使用 browse skill\n总结这页"), "invoked phrase");
assert(userInvokedSkill("/browse 这页"), "invoked slash");
assert(!userInvokedSkill("帮我看看这个网页文章讲了什么"), "plain question");
assert(!userInvokedSkill("总结这页的要点"), "shortcut prompt is not skill invoke");
assert(!userInvokedSkill("https://example.com/a"), "url not slash");
const shortcutSettings = {
  ...defaultSettings(),
  skillsEnabled: false,
  shortcuts: [{ id: "1", label: "总结", prompt: "总结这页的要点" }],
};
assert(!isSkillsEnabled(shortcutSettings), "skills default off");
assert(visibleSkills(shortcutSettings).length === 1, "shortcuts show when skills off");
assert(visibleSkills(shortcutSettings)[0].prompt === "总结这页的要点", "shortcut prompt kept");
assert(!userInvokedSkill("【页面正文】\n调用 /api/v1/users\n/usr/bin/env"), "page dump not skill");
assert(!systemPrompt({}).includes("load_skill"), "prompt default no skill");
assert(systemPrompt({}, { useSkills: true }).includes("用户已指定 skill"), "prompt with skill");

const composed = await composeSkillPrompt("使用 browse skill\n总结这页", skills);
assert(composed.includes("使用 browse skill") && composed.includes("打开浏览器"), "inline body");
const long = await composeSkillPrompt("使用 long-one skill", skills);
assert(long.includes("load_skill") && !long.includes("x".repeat(100)), "long defers");
assert((await composeSkillPrompt("普通问题", skills)) === "普通问题", "passthrough");

console.log("PASS slash");
