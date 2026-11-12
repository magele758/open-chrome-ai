// Topics are extracted locally. An edge between topics always has at least
// one clipping as evidence, so users can inspect the underlying passage.
const domains = {
  人工智能: ["机器学习", "神经网络", "人工智能", "大模型", "深度学习", "智能体", "machine learning", "neural network", "llm", "agent", "transformer"],
  软件工程: ["数据库", "编程", "软件", "架构", "测试", "开源", "typescript", "javascript", "python", "postgresql", "rust", "database"],
  商业与经济: ["经济", "金融", "投资", "股票", "商业", "市场", "融资", "finance", "investment", "economics"],
  人文与艺术: ["历史", "文学", "艺术", "绘画", "哲学", "音乐", "history", "philosophy", "music"],
  自然科学: ["物理", "数学", "化学", "生物", "天文", "physics", "biology", "chemistry"],
  生活与健康: ["健康", "营养", "旅行", "运动", "烹饪", "fitness", "nutrition", "travel"],
};
const stop = new Set("the this that with and for are from have about into not how what also your which their these those will can was were our you 这个 一个 这些 以及 可以 如何 我们 他们 进行 通过 什么 文章 内容 使用 介绍 可能 网页 未命名".split(" "));
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

export function describeClip(clip) {
  const scores = new Map();
  function score(word, weight) {
    word = word.trim().toLowerCase();
    if (word.length >= 2 && word.length <= 60 && !stop.has(word) && !/^\d+$/.test(word))
      scores.set(word, (scores.get(word) || 0) + weight);
  }
  const body = [clip.title, clip.note, clip.content].filter(Boolean).join("\n").toLowerCase();
  for (const [text, weight] of [[clip.title, 4], [clip.note, 3], [clip.content, 1]]) {
    for (const token of segmenter.segment(String(text || "").replace(/https?:\/\/\S+/g, " "))) {
      if (token.isWordLike) score(token.segment, weight);
    }
  }
  const labels = [];
  const tags = (Array.isArray(clip.tags) ? clip.tags : String(clip.tags || "").split(/[,，\s]+/))
    .map(t => String(t).replace(/^#/, "").trim().toLowerCase()).filter(Boolean);
  const searchable = body + "\n" + tags.join("\n");
  for (const [domain, terms] of Object.entries(domains)) {
    const found = terms.filter(term => /^[a-z]/.test(term)
      ? new RegExp("\\b" + term + "s?\\b", "i").test(searchable) : searchable.includes(term));
    if (found.length) labels.push(domain);
    for (const term of found) score(term, 12);
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([word]) => word);
  const topics = [...new Set([...tags, ...ranked])];
  return { domains: labels.length ? labels : ["其他领域"], topics: topics.length ? topics : ["待归类"] };
}

export function topicNeighborhood(rows, topic) {
  const sources = rows.filter(row => row.topics.includes(topic));
  const counts = new Map();
  for (const row of sources) for (const other of row.topics) {
    if (other !== topic) counts.set(other, (counts.get(other) || 0) + 1);
  }
  const related = [...counts].sort((a, b) => b[1] - a[1]).map(([topic, count]) => ({ topic, count }));
  return { sources, related };
}
