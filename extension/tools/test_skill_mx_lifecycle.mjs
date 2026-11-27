import { readFile } from "node:fs/promises";
import { findSkill, mergeSkills, skillCatalogText } from "../lib/agent/skills.js";
import { MAX_SKILL_WHEN, parseSkillMarkdown } from "../lib/skill-folder.js";
import {
  composeSkillPrompt,
  filterSlashItems,
  mentionedSkills,
  skillCommandText,
  slashItemsFromSkills,
  userInvokedSkill,
} from "../lib/slash.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const SKILL_ID = "tiktok-mx-lifecycle";
const SKILL_NAME = "TikTok 墨西哥上架闭环";
const INLINE_BODY_MAX = 12000;

const bundled = JSON.parse(await readFile(new URL("../skills/index.json", import.meta.url))).skills;
const entry = bundled.find((s) => s.id === SKILL_ID);
assert(entry, "index registers the lifecycle skill");
assert(entry.name === SKILL_NAME, "index display name");
assert(bundled.filter((s) => s.id === SKILL_ID).length === 1, "single index entry");
assert(
  typeof entry.when === "string" && entry.when.trim() && entry.when.length <= MAX_SKILL_WHEN,
  "index when hint within catalog clip",
);

const text = await readFile(new URL(`../skills/${SKILL_ID}/SKILL.md`, import.meta.url), "utf8");
const parsed = parseSkillMarkdown(text);
assert(parsed, "skill markdown parses");
assert(parsed.name === SKILL_NAME, "frontmatter name matches display name");
assert(parsed.when.trim() && parsed.when.length <= MAX_SKILL_WHEN, "frontmatter when usable as hint");
assert(parsed.body.length > 500 && parsed.body.length <= INLINE_BODY_MAX, "body inlines without deferring to load_skill");

const catalog = bundled.map((s) => ({ id: s.id, name: s.name, when: s.when }));
const lifecycle = findSkill(catalog, SKILL_NAME);
assert(lifecycle?.id === SKILL_ID, "findSkill by Chinese display name");
assert(findSkill(catalog, SKILL_ID)?.id === SKILL_ID, "findSkill by id");
assert(findSkill(catalog, "上架闭环") == null, "display name match stays exact");

const command = skillCommandText(lifecycle);
assert(command === `使用「${SKILL_NAME}」`, "multiword command text " + command);
assert(mentionedSkills(command, catalog)[0]?.id === SKILL_ID, "slash menu round-trips the display name");

const items = slashItemsFromSkills(catalog);
assert(items.some((item) => item.id === SKILL_ID && item.insert === command), "slash item registered");
assert(filterSlashItems(items, "上架闭环")[0]?.id === SKILL_ID, "filter by name part");
assert(filterSlashItems(items, "tiktok-mx-lifecycle")[0]?.id === SKILL_ID, "filter by id");
assert(filterSlashItems(items, "tiktok-mx").some((item) => item.id === SKILL_ID), "filter by id prefix");

const intent = "上架测试：建草稿、改到测试价、提审、确认在售后下架 https://shop.tiktok.com/jp/pdp/9000000000000000001";
const invoked = `使用「${SKILL_NAME}」${intent}`;
assert(userInvokedSkill(invoked, catalog), "quoted display name invokes the bundled skill");
assert(mentionedSkills(invoked, catalog).length === 1 && mentionedSkills(invoked, catalog)[0].id === SKILL_ID, "mention resolves");
assert(userInvokedSkill(invoked), "invocation without catalog still counts as skill intent");
assert(userInvokedSkill(`使用「${SKILL_NAME}」`, null), "quoted candidate before catalog loads");
assert(!userInvokedSkill(intent, catalog), "plain intent with catalog is not a skill invoke");
assert(mentionedSkills(`使用 ${SKILL_ID} skill 处理这个链接`, catalog)[0]?.id === SKILL_ID, "explicit id mention");

const both = `先使用「TikTok 墨西哥商品草稿」，再使用「${SKILL_NAME}」`;
assert(
  mentionedSkills(both, catalog).map((s) => s.id).join(",") === "tiktok-mx-draft,tiktok-mx-lifecycle",
  "two bundled skills resolve in order",
);

const loads = [];
const prepared = await composeSkillPrompt(invoked, catalog, {
  loadBody: async (skill) => {
    loads.push(skill.id);
    const body = skill.id === SKILL_ID ? parsed.body : "草稿说明";
    return { ...skill, body };
  },
});
assert(loads.join(",") === SKILL_ID, "load body once for the mentioned skill only");
assert(prepared.startsWith(invoked), "composed prompt keeps the user text first");
assert(prepared.includes(`【skill:${SKILL_ID} ${SKILL_NAME}】`), "composed block header");
assert(prepared.includes(parsed.body), "composed prompt injects the full body");

const body = parsed.body;
for (const marker of [
  "ptc_create_mx_draft",
  "ptc_inspect_mx_draft",
  "ptc_repair_mx_draft",
  "reprice_draft",
  "publish_draft",
  "listing_status",
  "delist_listing",
  "optimize_listing",
  "read_orders",
  '"multiplier":100',
  '"maxTotalStock":10',
  "baselinePricesMXN",
  "packagedWeightGrams",
  "packageCm",
  "priceMXN",
  "stock",
  "brand",
  "--timeout 180000",
  "agent-outbox",
  "两个完整轮询周期",
  "Unexpected stock change",
  "1738630710999877196",
  "verified:true",
  'status:"inactive"',
  "不直连 CDP",
]) {
  assert(body.includes(marker), `body keeps contract marker ${marker}`);
}

const merged = mergeSkills(catalog, [{ id: SKILL_ID, name: "folder copy", when: "" }]);
assert(merged.find((s) => s.id === SKILL_ID).name === SKILL_NAME, "bundled entry wins over folder");

const menu = skillCatalogText(catalog);
assert(menu.includes(`${SKILL_ID}：${SKILL_NAME}`), "catalog lists the new skill");

console.log("PASS skill-mx-lifecycle");
