/**
 * PageLens - Reviews Module
 * Handles Daily, Weekly, and Monthly Knowledge Reviews & Reflections:
 * 1. Time range & period calculations (Daily, ISO Weekly, Monthly)
 * 2. Aggregating & filtering clippings (from chrome.storage.local `pagelens_clippings`)
 * 3. Specialized review & reflection prompts (thematic clusters, user notes synthesis, action steps)
 * 4. Persistence of generated reviews in `chrome.storage.local` (`pagelens_reviews`)
 * 5. Exporting reviews to Obsidian vault & appending to daily journal notes
 */

import { readLibraryText, writeLibraryText, deleteLibraryFile } from "./library.js";
import { listAllClippings, yamlScalar, getLocalDateString } from "./clippings.js";
import { completeChat, streamChat, estimateTokens } from "./openai.js";

export const REVIEWS_STORAGE_KEY = "pagelens_reviews";

/**
 * Calculates ISO 8601 week number and week-year for a given date.
 */
export function getIsoWeekInfo(dateInput = Date.now()) {
  const target = new Date(dateInput);
  target.setHours(0, 0, 0, 0);
  // ISO day: 1 = Monday, ..., 7 = Sunday
  const dayNr = ((target.getDay() + 6) % 7) + 1;
  // Set to nearest Thursday: current date + 4 - current day number
  target.setDate(target.getDate() + 4 - dayNr);
  const year = target.getFullYear();
  // January 4th is always in week 1 of that year
  const jan4 = new Date(year, 0, 4);
  const jan4DayNr = ((jan4.getDay() + 6) % 7) + 1;
  const firstThursday = new Date(year, 0, 4 + (4 - jan4DayNr));
  const weekNum = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { year, week: Math.max(1, Math.min(53, weekNum)) };
}

/**
 * Formats a Date object to YYYY-MM-DD in local time.
 */
export function formatLocalDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Calculates start, end, key, and label for a review period.
 * @param {"daily" | "weekly" | "monthly"} type
 * @param {number|Date|string} dateInput
 */
export function getReviewPeriod(type = "daily", dateInput = Date.now()) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) {
    return getReviewPeriod(type, Date.now());
  }

  if (type === "daily") {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    const key = formatLocalDate(start);

    // Natural relative label
    const todayStr = formatLocalDate(new Date());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatLocalDate(yesterday);

    let relative = "";
    if (key === todayStr) relative = "（今天）";
    else if (key === yesterdayStr) relative = "（昨天）";

    const prevDate = new Date(start.getTime() - 86400000);
    const nextDate = new Date(start.getTime() + 86400000);

    return {
      type: "daily",
      key,
      label: `${key}${relative} 每日复盘`,
      shortLabel: `${key}${relative}`,
      start: start.getTime(),
      end: end.getTime(),
      prevDate: prevDate.getTime(),
      nextDate: nextDate.getTime(),
    };
  }

  if (type === "weekly") {
    const dayOfWeek = (d.getDay() + 6) % 7; // 0 = Mon, ..., 6 = Sun
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dayOfWeek, 0, 0, 0, 0);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999);

    const { year, week } = getIsoWeekInfo(start);
    const weekPad = String(week).padStart(2, "0");
    const key = `${year}-W${weekPad}`;

    const startM = String(start.getMonth() + 1).padStart(2, "0");
    const startD = String(start.getDate()).padStart(2, "0");
    const endM = String(end.getMonth() + 1).padStart(2, "0");
    const endD = String(end.getDate()).padStart(2, "0");

    const curWeekInfo = getIsoWeekInfo(new Date());
    let relative = "";
    if (year === curWeekInfo.year && week === curWeekInfo.week) {
      relative = "（本周）";
    } else if (year === curWeekInfo.year && week === curWeekInfo.week - 1) {
      relative = "（上周）";
    }

    const prevDate = new Date(start.getTime() - 7 * 86400000);
    const nextDate = new Date(start.getTime() + 7 * 86400000);

    return {
      type: "weekly",
      key,
      year,
      week,
      label: `${year}年 第${week}周${relative} (${startM}.${startD} - ${endM}.${endD})`,
      shortLabel: `第${week}周${relative}`,
      start: start.getTime(),
      end: end.getTime(),
      prevDate: prevDate.getTime(),
      nextDate: nextDate.getTime(),
    };
  }

  if (type === "monthly") {
    const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    const monthPad = String(d.getMonth() + 1).padStart(2, "0");
    const key = `${d.getFullYear()}-${monthPad}`;

    const now = new Date();
    let relative = "";
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
      relative = "（本月）";
    } else {
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      if (d.getFullYear() === lastMonth.getFullYear() && d.getMonth() === lastMonth.getMonth()) {
        relative = "（上月）";
      }
    }

    const prevDate = new Date(d.getFullYear(), d.getMonth() - 1, 15);
    const nextDate = new Date(d.getFullYear(), d.getMonth() + 1, 15);

    return {
      type: "monthly",
      key,
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      label: `${d.getFullYear()}年${monthPad}月${relative} 每月复盘`,
      shortLabel: `${d.getFullYear()}年${monthPad}月${relative}`,
      start: start.getTime(),
      end: end.getTime(),
      prevDate: prevDate.getTime(),
      nextDate: nextDate.getTime(),
    };
  }

  throw new Error(`未知复盘类型: ${type}`);
}

/**
 * Filters clippings that fall within the given timestamp range.
 */
export function filterClippingsForPeriod(clippings = [], { start, end }) {
  if (!Array.isArray(clippings)) return [];
  return clippings
    .filter((clip) => {
      const t = Number(clip?.createdAt || 0);
      return t >= start && t <= end;
    })
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * Extracts distinct tags and host domains from a collection of clippings.
 */
export function getClippingsMetadata(clippings = []) {
  const tagSet = new Set();
  const domainSet = new Set();
  for (const c of clippings) {
    const tags = Array.isArray(c.tags) ? c.tags : String(c.tags || "").split(/[,，\s]+/);
    tags.map((t) => String(t).trim().replace(/^#/, "")).filter(Boolean).forEach((t) => tagSet.add(t));
    if (c.url) {
      try {
        const u = new URL(c.url);
        domainSet.add(u.hostname.replace(/^www\./, ""));
      } catch {
        /* ignore */
      }
    }
  }
  return {
    tags: Array.from(tagSet),
    domains: Array.from(domainSet),
    count: clippings.length,
  };
}

/**
 * Formats clippings into structured text for LLM ingestion.
 */
export function formatClippingsForPrompt(clippings = []) {
  if (!clippings.length) return "（本周期内暂无收藏内容）";

  return clippings
    .map((c, i) => {
      const idx = i + 1;
      const title = c.title || "未命名网页";
      const url = c.url ? `[${title}](${c.url})` : title;
      const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleString("zh-CN") : "未知时间";
      const tags = Array.isArray(c.tags)
        ? c.tags.join(", ")
        : String(c.tags || "").trim();

      const parts = [`#### 条目 ${idx}：${url}`];
      parts.push(`- ⏱️ 收藏时间：${dateStr}`);
      if (tags) parts.push(`- 🏷️ 标签分类：${tags}`);
      if (c.note && c.note.trim()) {
        parts.push(`- 💡 用户个人思考/备注文摘：${c.note.trim()}`);
      }
      if (c.content && c.content.trim()) {
        parts.push(`- 📄 AI 提炼的核心观点与摘要：\n${c.content.trim()}`);
      }
      return parts.join("\n");
    })
    .join("\n\n---\n\n");
}

/**
 * Constructs system and user prompts tailored for knowledge review & reflection.
 */
export function buildReviewPrompt({
  type = "daily",
  clippings = [],
  periodLabel = "",
  language = "zh-CN",
  customGuidance = "",
}) {
  const meta = getClippingsMetadata(clippings);
  const clippingsText = formatClippingsForPrompt(clippings);

  const langInstruction = language === "en" ? "Answer in English." : "请使用简体中文回答。";

  let frameworkInstruction = "";
  if (type === "daily") {
    frameworkInstruction = `
你是一位专业的个人知识顾问与认知反思导师。这是用户在「${periodLabel}」当天收藏与思考的内容。
请按以下结构输出深度复盘总结（Markdown 格式）：

# 📅 ${periodLabel}

> 📊 **今日盘点**：共收藏 **${meta.count}** 篇内容 · 涉及领域/标签：${meta.tags.map(t => '#' + t).join(" ") || "综合"}

## 1. 🌟 今日核心突破与关键洞察 (Key Insights)
- 提炼今天输入内容中最有价值、颠覆性或具有长期价值的 2~3 个核心观点。
- 拒绝浅层罗列，讲清楚“底层原理是什么”、“为什么重要”。

## 2. 🧠 个人思考串联与反思 (Thinking & Resonance)
- **极为关键的一步**：深入剖析用户在每篇收藏中留下的“个人思考/备注文摘（💡）”。
- 用户在关注什么？这些思考与收藏文章碰撞出了什么灵感？是否有潜在的矛盾、直觉或行动线索？

## 3. 🗺️ 今日知识连线 (Connecting the Dots)
- 寻找今天不同收藏条目之间的隐藏关联或跨学科启发（若条目较少，则提炼该条目与经典心智模型/工程实践的连接）。

## 4. 🎯 明日/行动启发 (Actionable Takeaways)
- 基于今天的输入与思考，提炼出 1~3 条明确的践行建议、待求证问题或下一步延伸方向。

## 📌 收藏索引
- 简短列出今日收藏清单及对应链接，方便随时回溯。
`;
  } else if (type === "weekly") {
    frameworkInstruction = `
你是一位资深的高阶思维导师与知识体系架构师。这是用户在「${periodLabel}」整周累积收藏与思考的内容。
每周复盘旨在打破单篇碎片壁垒，构建主题图谱，看清认知演变轨迹。
请按以下结构输出深度复盘总结（Markdown 格式）：

# 📆 ${periodLabel}

> 📈 **本周知识雷达**：共沉淀 **${meta.count}** 篇高质量内容 · 涉及主题：${meta.tags.map(t => '#' + t).join(" ") || "跨领域"} · 核心信息源：${meta.domains.join(", ") || "多来源"}

## 1. 🗺️ 本周核心主题图谱 (Thematic Clusters)
- 将本周收藏内容归纳为 2~3 个核心主题领域（如技术架构、商业认知、认知范式等）。
- 对每个主题进行系统化梳理，提炼出具有体系感的逻辑框架。

## 2. 💎 认知升级与高价值模型 (Mental Models & Breakthroughs)
- 提炼本周最值得长期保留的思维模型、方法论、架构模式或判断标准。
- 阐述该认知对用户工作与思考带来的本质改变。

## 3. 🔍 个人探索轨迹与思考演变 (Curiosity & Reflections)
- 结合用户本周在收藏中记录的所有个人思考（💡），总结用户本周的思考重心、好奇心走向。
- 识别用户在哪些地方产生了深度共鸣，在哪些地方产生了批判性疑问。

## 4. ⚡️ 跨领域交叉连接 (Cross-Domain Synergy)
- 跨越不同文章与主题，指出看似不相关的条目之间存在的底层共性、相互补足或对立张力。

## 5. 🚀 下周沉淀与实践方向 (Next Week's Focus)
- 针对本周未尽的思考，提出 2~3 个值得在下周继续深挖的研究课题、实践实验或求证方向。

## 📚 本周精选书签索引
- 结构化罗列本周收藏列表（标题、标签及原文链接）。
`;
  } else {
    // monthly
    frameworkInstruction = `
你是一位大师级思维顾问与个人智库总建筑师。这是用户在「${periodLabel}」一个月内沉淀的所有收藏、AI 提炼与个人思考。
月度复盘是极高层次的知识资产盘点与思维跃迁总结。
请按以下结构输出深度复盘总结（Markdown 格式）：

# 🗓️ ${periodLabel}

> 🧭 **月度资产总览**：累计沉淀 **${meta.count}** 项知识资产 · 覆盖核心领域：${meta.tags.map(t => '#' + t).join(" ") || "全景"}

## 1. 🌐 月度宏观知识全景 (Monthly Knowledge Map)
- 勾勒用户本月构建的知识版图，用清晰的层级展现本月的主攻领域与边缘探索。

## 2. 🏛️ 本月三大核心底层模型 (Foundational Models)
- 从全月海量输入中，甄选出最深刻的 3 大底层原理/模型/系统化思考，给出权威透彻的解构。

## 3. 🧬 思维演进与心智相变 (Mental Shift & Evolution)
- 综合全月所有个人思考备注，诊断用户的认知演进路径：
  - 月初到月末，思考视角发生了怎样的跃迁？
  - 破除了哪些既有偏见？形成了哪些新的认知锚点？

## 4. 📦 个人智库资产归档与沉淀 (Knowledge Assets)
- 哪些工具、代码库、论证架构、实践方案应当转变为永久 SOP 或知识卡片？

## 5. 🔭 下月战略探索建议 (Strategic Trajectory)
- 站在知识系统演进的高度，为下个月的阅读输入、项目实践提出高信噪比的规划建议。

## 📑 资产索引汇总
- 整理分类索引清单与链接。
`;
  }

  const system = `你是一位卓越的个人知识管理（PKM）导师与认知反思顾问。你的任务是根据用户提供的收藏材料（包含原文标题、链接、标签、个人思考备注和 AI 核心提炼），为用户撰写一份兼具深度洞察、认知升华与行动指导的高质量复盘报告。
原则：
1. 尊重材料真实性，引用真实链接与标题；
2. 极其重视并充分融合用户的个人思考（💡 标注部分），这是复盘的灵魂；
3. 输出排版优雅、层次清晰的 Markdown；
4. ${langInstruction}`;

  const user = `${frameworkInstruction}

${customGuidance ? `【用户特别关注点/自定义要求】：\n${customGuidance}\n\n` : ""}
以下是「${periodLabel}」时间窗口内的所有收藏条目材料：

${clippingsText}`;

  return { system, user };
}

/**
 * Reads all saved reviews from chrome.storage.local.
 */
export async function listAllReviews() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  const data = await chrome.storage.local.get(REVIEWS_STORAGE_KEY);
  const items = Array.isArray(data[REVIEWS_STORAGE_KEY]) ? data[REVIEWS_STORAGE_KEY] : [];
  return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Retrieves a saved review by period key (e.g. 2026-09-14 or 2026-W38 or 2026-09).
 */
export async function getReviewByKey(periodKey) {
  if (!periodKey) return null;
  const list = await listAllReviews();
  return list.find((r) => r.periodKey === periodKey) || null;
}

/**
 * Saves or updates a review record in chrome.storage.local.
 */
export async function saveReviewRecord(review) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return review;
  const list = await listAllReviews();
  const next = [review, ...list.filter((r) => r.id !== review.id && r.periodKey !== review.periodKey)];
  const capped = next.slice(0, 500);
  await chrome.storage.local.set({ [REVIEWS_STORAGE_KEY]: capped });
  return review;
}

/**
 * Deletes a saved review record by ID.
 */
export async function deleteReviewRecord(id) {
  if (!id || typeof chrome === "undefined" || !chrome.storage?.local) return;
  const list = await listAllReviews();
  const next = list.filter((r) => r.id !== id);
  await chrome.storage.local.set({ [REVIEWS_STORAGE_KEY]: next });
}

/**
 * Returns Obsidian-relative path for saving review note.
 * e.g. PageLens/reviews/daily/2026-09-14-review.md
 *      PageLens/reviews/weekly/2026-W38-review.md
 *      PageLens/reviews/monthly/2026-09-review.md
 */
export function reviewNoteRelPath(review) {
  const type = review.type || "daily";
  const key = review.periodKey || getLocalDateString(review.createdAt || Date.now());
  return `PageLens/reviews/${type}/${key}-review.md`;
}

/**
 * Formats a review object into an Obsidian-compatible Markdown document with frontmatter.
 */
export function reviewToObsidianMarkdown(review) {
  const now = new Date(review.createdAt || Date.now());
  const dateStr = now.toISOString().replace("T", " ").slice(0, 19);
  const type = review.type || "daily";
  const count = Number(review.clippingCount || review.clippings?.length || 0);

  const tags = ["pagelens", "review", `${type}-review`];
  if (Array.isArray(review.tags)) {
    for (const t of review.tags) {
      const clean = String(t).trim().replace(/^#/, "");
      if (clean && !tags.includes(clean)) tags.push(clean);
    }
  }

  const fm = [
    "---",
    `title: ${yamlScalar(review.title || review.periodLabel || "知识复盘")}`,
    `type: ${yamlScalar(type)}`,
    `period_key: ${yamlScalar(review.periodKey || "")}`,
    `created_at: ${yamlScalar(dateStr)}`,
    `clipping_count: ${count}`,
    `tags: [${tags.map((t) => yamlScalar(t)).join(", ")}]`,
    "source: PageLens Review",
    "---",
    "",
  ];

  return fm.join("\n") + (review.content || "").trim() + "\n";
}

/**
 * Writes review document to user's Obsidian library.
 */
export async function writeReviewToObsidian(review, { request = false } = {}) {
  const rel = reviewNoteRelPath(review);
  const md = reviewToObsidianMarkdown(review);
  const written = await writeLibraryText(rel, md, { request });
  return { ...written, path: rel };
}

/**
 * Appends a daily review to today's Obsidian Daily Note (e.g. Daily/2026-09-14.md).
 */
export async function appendReviewToDailyNote(review, { folder = "Daily", libraryRoot = "", request = false } = {}) {
  const d = new Date(review.createdAt || Date.now());
  const day = getLocalDateString(d);
  let cleanFolder = String(folder || "Daily").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  const relPath = cleanFolder ? `${cleanFolder}/${day}.md` : `${day}.md`;

  let existing = null;
  try {
    const res = await readLibraryText(relPath, { request });
    if (res?.ok) existing = res.text || "";
  } catch {
    existing = null;
  }

  const reviewSectionHeader = `## 🧠 每日复盘与回顾 (${review.periodLabel || day})`;
  if (existing && existing.includes(reviewSectionHeader)) {
    return { ok: true, path: relPath, skipped: true, reason: "duplicate" };
  }

  const sectionBody = `\n${reviewSectionHeader}\n\n${(review.content || "").trim()}\n`;

  let finalContent = "";
  if (existing === null) {
    finalContent = `# ${day}\n${sectionBody}`;
  } else {
    finalContent = `${existing.trimEnd()}\n\n${sectionBody}`;
  }

  const written = await writeLibraryText(relPath, finalContent, { request });
  return { ...written, path: relPath, skipped: false, created: existing === null };
}

/**
 * High-level function to generate a review summary using the user's active LLM model.
 */
export async function generateReviewSummary({
  type = "daily",
  dateInput = Date.now(),
  clippings = null,
  model,
  language = "zh-CN",
  customGuidance = "",
  signal,
  onDelta,
  complete = completeChat,
  stream = streamChat,
}) {
  const period = getReviewPeriod(type, dateInput);

  // If clippings are not passed in, load from storage
  let targetClippings = clippings;
  if (!targetClippings) {
    const all = await listAllClippings();
    targetClippings = filterClippingsForPeriod(all, period);
  }

  if (!targetClippings.length) {
    throw new Error(`在「${period.label}」时段内未找到任何收藏内容。请先收藏网页或对话回答后再进行复盘。`);
  }

  const { system, user } = buildReviewPrompt({
    type,
    clippings: targetClippings,
    periodLabel: period.label,
    language,
    customGuidance,
  });

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  let fullText = "";
  const handleDelta = (delta) => {
    if (typeof delta === "string") {
      fullText += delta;
      onDelta?.(delta, fullText);
    }
  };

  if (typeof stream === "function") {
    await stream(model, { messages, signal, maxTokens: 8192 }, handleDelta);
  } else {
    fullText = await complete(model, { messages, signal, maxTokens: 8192 });
    onDelta?.(fullText, fullText);
  }

  const meta = getClippingsMetadata(targetClippings);
  const reviewRecord = {
    id: `review-${type}-${period.key}-${Date.now()}`,
    type,
    periodKey: period.key,
    periodLabel: period.label,
    dateRange: { start: period.start, end: period.end },
    clippingIds: targetClippings.map((c) => c.id).filter(Boolean),
    clippingCount: targetClippings.length,
    tags: meta.tags,
    title: period.label,
    content: fullText.trim(),
    createdAt: Date.now(),
    obsidianPath: null,
    dailyNoteAppended: false,
  };

  // Automatically save to local storage
  await saveReviewRecord(reviewRecord);

  return reviewRecord;
}
