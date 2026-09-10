import { findSkill } from "./agent/skills.js";

const INLINE_BODY_MAX = 12000;
const SLASH_LIMIT = 20;

export function skillCommandText(skill) {
  const name = String(skill?.name || skill?.id || "").trim() || "skill";
  return `使用 ${name} skill`;
}

export function slashItemsFromSkills(skills) {
  return (skills || [])
    .filter((s) => s?.id)
    .map((s) => ({
      kind: "skill",
      id: s.id,
      name: s.name || s.id,
      hint: s.when || "",
      insert: skillCommandText(s),
      skill: s,
    }));
}

export function parseSlashToken(text, cursor) {
  const s = String(text ?? "");
  const pos = Math.max(0, Math.min(s.length, Number.isFinite(cursor) ? cursor : s.length));
  const before = s.slice(0, pos);
  const m = before.match(/(^|\s)\/([^\s]*)$/);
  if (!m) return null;
  const query = m[2];
  const start = pos - query.length - 1;
  return { start, end: pos, query };
}

export function filterSlashItems(items, query) {
  const q = String(query || "").trim().toLowerCase();
  const list = Array.isArray(items) ? items : [];
  if (!q) return list.slice(0, SLASH_LIMIT);
  const scored = [];
  for (const item of list) {
    const id = String(item.id || "").toLowerCase();
    const name = String(item.name || "").toLowerCase();
    const hint = String(item.hint || "").toLowerCase();
    const tail = id.split("/").pop();
    let score = 0;
    if (id === q || name === q) score = 100;
    else if (id.startsWith(q) || name.startsWith(q) || tail.startsWith(q)) score = 80;
    else if (id.includes(q) || name.includes(q) || tail.includes(q)) score = 50;
    else if (hint.includes(q)) score = 20;
    else continue;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)));
  return scored.map((x) => x.item).slice(0, SLASH_LIMIT);
}

export function applySlashItem(text, token, item) {
  const s = String(text ?? "");
  const start = Math.max(0, Number(token?.start) || 0);
  const end = Math.max(start, Number(token?.end) || start);
  const insert = String(item?.insert || skillCommandText(item)).trim();
  const rest = s.slice(end).replace(/^\s*/, "");
  const next = rest ? `${s.slice(0, start)}${insert} ${rest}` : `${s.slice(0, start)}${insert} `;
  return { text: next, cursor: start + insert.length + 1 };
}

export function userInvokedSkill(text) {
  const s = String(text || "");
  if (/使用\s+\S+\s+skill/i.test(s)) return true;
  return /^\s*\/[A-Za-z0-9_\-\u4e00-\u9fff]/.test(s);
}

export function mentionedSkills(text, skills) {
  const found = [];
  const seen = new Set();
  const re = /使用\s+(\S+?)\s+skill/gi;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const hit = findSkill(skills, m[1]);
    if (!hit) continue;
    const key = hit.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(hit);
  }
  return found;
}

export async function composeSkillPrompt(userText, skills, { loadBody } = {}) {
  const text = String(userText || "");
  const used = mentionedSkills(text, skills);
  if (!used.length) return text;
  const ready = [];
  for (const skill of used) {
    let s = skill;
    if (!s.body && typeof loadBody === "function") {
      s = (await loadBody(s)) || s;
    }
    ready.push(s);
  }
  const blocks = ready.map((s) => {
    if (s.body && s.body.length <= INLINE_BODY_MAX) {
      return `【skill:${s.id} ${s.name}】\n${s.body}`;
    }
    return `请先 load_skill，id 为「${s.id}」。`;
  });
  return `${text.trim()}\n\n按以下 skill 说明执行：\n\n${blocks.join("\n\n")}`;
}
