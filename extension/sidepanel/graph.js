import { drawTopicMap } from "./topic-map.js";
import { CLIPPINGS_STORAGE_KEY, listAllClippings } from "../lib/clippings.js";
import { describeClip, topicNeighborhood } from "../lib/clipping-graph.js";

const $ = id => document.getElementById(id);
const assignmentKey = "pl.topic.domain:";
const clipTopicKey = "pl.clip.topics:";
let rows = [], assignments = {}, selected = "";
function button(text, click) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = text;
  el.onclick = click;
  return el;
}
function topicDomains(row, topic) {
  const assigned = assignments[assignmentKey + topic];
  return assigned ? [assigned] : row.domains;
}
function renderDomains() {
  const domain = $("domain"), value = domain.value;
  const names = new Set(rows.flatMap(row => row.topics.flatMap(t => topicDomains(row, t))));
  domain.replaceChildren(new Option("全部领域", ""), ...[...names].sort().map(x => new Option(x, x)));
  domain.value = names.has(value) ? value : "";
}
function render() {
  const query = $("query").value.trim().toLowerCase(), domain = $("domain").value;
  const counts = new Map();
  for (const row of rows) {
    for (const topic of row.topics) {
      if (domain && !topicDomains(row, topic).includes(domain)) continue;
      if (query && !topic.includes(query) && !row.search.includes(query)) continue;
      counts.set(topic, (counts.get(topic) || 0) + 1);
    }
  }
  const sorted = [...counts].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!counts.has(selected)) selected = sorted[0]?.[0] || "";
  $("topics").replaceChildren(...sorted.map(([name, count]) => {
    const el = button(name + " · " + count, () => { selected = name; render(); });
    el.setAttribute("aria-pressed", String(selected === name));
    return el;
  }));
  const graph = topicNeighborhood(rows.filter(r => !domain || topicDomains(r, selected).includes(domain)), selected);
  $("heading").textContent = selected || (rows.length ? "无匹配主题" : "还没有剪藏");
  $("summary").textContent = selected ? graph.sources.length + " 篇来源 · 连线表示两个主题出现在同一篇剪藏中" : "";
  $("assign").hidden = !selected;
  $("custom").value = assignments[assignmentKey + selected] || "";
  function jump(topic) {
    $("query").value = ""; $("domain").value = ""; selected = topic; render();
  }
  $("map").replaceChildren(...(selected ? [drawTopicMap(selected, graph.related, jump)] : []));
  $("edges").replaceChildren(...graph.related.map(({ topic, count }) =>
    button(topic + " · " + count + " 篇", () => jump(topic))));
  $("sources").replaceChildren(...graph.sources.map(row => {
    const article = document.createElement("article");
    const link = document.createElement(/^https?:\/\//i.test(row.url) ? "a" : "strong");
    link.textContent = row.title || row.url || "未命名剪藏";
    if (link.tagName === "A") { link.href = row.url; link.target = "_blank"; link.rel = "noopener noreferrer"; }
    const detail = document.createElement("details"), summary = document.createElement("summary"), body = document.createElement("p");
    summary.textContent = "查看剪藏内容";
    body.textContent = [row.note, row.content].filter(Boolean).join("\n\n");
    const form = document.createElement("form"), label = document.createElement("label");
    const input = document.createElement("input"), save = document.createElement("button");
    label.textContent = "为这篇剪藏补充主题（用逗号分隔）";
    input.value = row.extraTopics.join("，");
    label.append(input);
    save.textContent = "保存主题";
    form.append(label, save);
    form.onsubmit = async event => {
      event.preventDefault();
      const topics = [...new Set(input.value.split(/[,，]/).map(t => t.trim().toLowerCase()).filter(Boolean))];
      try { await chrome.storage.local.set({ [clipTopicKey + row.id]: topics }); }
      catch (err) { report(err); }
    };
    detail.append(summary, body, form);
    article.append(link, detail);
    return article;
  }));
}
let revision = 0;
async function refresh() {
  const rev = ++revision;
  const clips = await listAllClippings();
  const next = clips.map(c => ({ ...c, ...(c.topicIndex?.version === 1 ? c.topicIndex : describeClip(c)),
    search: [c.title,c.note,c.content].join("\n").toLowerCase() }));
  const extras = await chrome.storage.local.get(next.map(row => clipTopicKey + row.id));
  for (const row of next) {
    row.extraTopics = extras[clipTopicKey + row.id] || [];
    row.topics = [...new Set([...row.topics, ...row.extraTopics])];
  }
  const keys = [...new Set(next.flatMap(row => row.topics.map(t => assignmentKey + t)))];
  const prefs = await chrome.storage.local.get(keys);
  if (rev !== revision) return;
  rows = next; assignments = prefs; renderDomains(); render();
}
const report = err => { $("summary").textContent = err.message; };
$("query").oninput = $("domain").onchange = render;
$("assign").onsubmit = async event => {
  event.preventDefault();
  const name = $("custom").value.trim();
  if (!name || !selected) return;
  try {
    await chrome.storage.local.set({ [assignmentKey + selected]: name });
    $("domain").value = "";
    await refresh();
  } catch (err) { report(err); }
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some(k => k === CLIPPINGS_STORAGE_KEY || k.startsWith(assignmentKey) || k.startsWith(clipTopicKey))) refresh().catch(report);
});
refresh().catch(report);
