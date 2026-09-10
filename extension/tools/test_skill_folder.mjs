import {
  clipSkillWhen,
  isSkillFile,
  parseSimpleYaml,
  parseSkillMarkdown,
  scanSkillTree,
  shouldSkipDir,
  skillIdFromPath,
  skillsFromFiles,
} from "../lib/skill-folder.js";
import { findSkill, mergeSkills, skillCatalogText } from "../lib/agent/skills.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fileHandle(name, text) {
  return {
    kind: "file",
    name,
    async getFile() {
      return { text: async () => text };
    },
  };
}

function dirHandle(name, children) {
  return {
    kind: "directory",
    name,
    async *entries() {
      for (const [n, handle] of Object.entries(children)) yield [n, handle];
    },
  };
}

assert(isSkillFile("SKILL.md") && isSkillFile("skill.md") && !isSkillFile("README.md"), "skill file name");
assert(shouldSkipDir("node_modules") && shouldSkipDir(".git") && shouldSkipDir(".cursor"), "skip dirs");
assert(!shouldSkipDir("gstack") && !shouldSkipDir("find-skills"), "keep skill dirs");

assert(skillIdFromPath("find-skills/SKILL.md") === "find-skills", "id folder");
assert(skillIdFromPath("gstack/browse/SKILL.md") === "gstack/browse", "id nested");
assert(skillIdFromPath("SKILL.md", "skills") === "skills", "id root uses folder name");

const yaml = parseSimpleYaml("name: demo\ndescription: 用于测试\nwhen: 旧字段\n");
assert(yaml.name === "demo" && yaml.description === "用于测试", "yaml scalars");

const folded = parseSimpleYaml("name: x\ndescription: |\n  第一行\n  第二行\n");
assert(folded.description.includes("第一行") && folded.description.includes("第二行"), "yaml block");

const parsed = parseSkillMarkdown(`---
name: find-skills
description: 帮用户找现成 skill。
---

# Find Skills
按说明执行。
`);
assert(parsed.name === "find-skills" && /找现成/.test(parsed.when) && parsed.body.includes("# Find Skills"), "parse md");
assert(parseSkillMarkdown("   ") === null, "empty md");

assert(clipSkillWhen("a".repeat(200)).endsWith("…") && clipSkillWhen("短").length === 1, "clip when");

const tree = dirHandle("skills", {
  "find-skills": dirHandle("find-skills", {
    "SKILL.md": fileHandle("SKILL.md", "---\nname: find-skills\ndescription: 搜索 skill\n---\n正文"),
  }),
  gstack: dirHandle("gstack", {
    browse: dirHandle("browse", {
      "SKILL.md": fileHandle("SKILL.md", "---\nname: browse\ndescription: 浏览网页\n---\n打开浏览器"),
    }),
    "README.md": fileHandle("README.md", "not a skill"),
  }),
  node_modules: dirHandle("node_modules", {
    fake: dirHandle("fake", {
      "SKILL.md": fileHandle("SKILL.md", "---\nname: leaked\n---\n不应加载"),
    }),
  }),
  ".hidden": dirHandle(".hidden", {
    "SKILL.md": fileHandle("SKILL.md", "---\nname: hidden\n---\n不应加载"),
  }),
});

const scanned = await scanSkillTree(tree);
assert(scanned.files.length === 2, "scan count " + scanned.files.length);
assert(!scanned.truncated, "not truncated");

const folderSkills = await skillsFromFiles(scanned.files, { rootName: "skills" });
assert(folderSkills.map((s) => s.id).join(",") === "find-skills,gstack/browse", "ids " + folderSkills.map((s) => s.id));
assert(folderSkills.every((s) => s.source === "folder"), "source");
assert(folderSkills[0].body.includes("正文"), "body kept");

const capped = await scanSkillTree(tree, { maxSkills: 1 });
assert(capped.files.length === 1 && capped.truncated, "max skills");

const bundled = [{ id: "find-skills", name: "bundled", body: "包内优先" }];
const merged = mergeSkills(bundled, folderSkills);
assert(merged[0].body === "包内优先" && merged.length === 2, "bundled wins");

assert(findSkill(folderSkills, "gstack/browse")?.name === "browse", "exact id");
assert(findSkill(folderSkills, "browse")?.id === "gstack/browse", "unique suffix");
assert(findSkill(folderSkills, "missing") === null, "missing");
assert(
  findSkill(
    [
      { id: "a/demo", name: "A" },
      { id: "b/demo", name: "B" },
    ],
    "demo",
  ) === null,
  "ambiguous suffix",
);

const catalog = skillCatalogText(folderSkills);
assert(catalog.includes("load_skill") && catalog.includes("gstack/browse"), "catalog");

console.log("PASS skill-folder");
