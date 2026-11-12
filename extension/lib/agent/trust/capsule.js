/**
 * 意图胶囊：在任何页面内容进入上下文之前，从委托人（用户 prompt / 持 token 的外部 Agent）的指令里
 * 确定性地抽出授权范围。页面、PDF、字幕、工具结果永远不进入这里。
 */
import { ACTION_CATEGORIES, toolCategory, urlHost, urlOrigin } from "./tool-classes.js";

export const CAPSULE_VERSION = 1;

/** 已知平台：关键词 → 平台 id（与 COSE 平台 id 一致）与可作用的域名 */
export const KNOWN_PLATFORMS = Object.freeze([
  { id: "wechat", re: /公众号|微信|wechat|weixin/i, domains: ["mp.weixin.qq.com"] },
  { id: "zhihu", re: /知乎|zhihu/i, domains: ["zhihu.com"] },
  { id: "juejin", re: /掘金|juejin/i, domains: ["juejin.cn"] },
  { id: "csdn", re: /csdn/i, domains: ["csdn.net"] },
  { id: "xiaohongshu", re: /小红书|xiaohongshu|rednote/i, domains: ["xiaohongshu.com"] },
  { id: "weibo", re: /微博|weibo/i, domains: ["weibo.com"] },
  { id: "bilibili", re: /[bB]站|哔哩|bilibili/i, domains: ["bilibili.com"] },
  { id: "douyin", re: /抖音|douyin/i, domains: ["douyin.com"] },
  { id: "toutiao", re: /头条号|今日头条|toutiao/i, domains: ["toutiao.com"] },
  { id: "x", re: /推特|twitter|\bx\.com\b|\btweet/i, domains: ["x.com", "twitter.com"] },
  { id: "github", re: /github/i, domains: ["github.com"] },
  { id: "gmail", re: /gmail|谷歌邮箱/i, domains: ["mail.google.com"] },
  { id: "youtube", re: /youtube|油管/i, domains: ["youtube.com"] },
  { id: "notion", re: /notion/i, domains: ["notion.so"] },
  { id: "medium", re: /\bmedium\b/i, domains: ["medium.com"] },
]);

const PLATFORM_BY_ID = new Map(KNOWN_PLATFORMS.map((p) => [p.id, p]));

const ACTION_KEYWORDS = {
  navigate: /打开|访问|前往|跳转|进入|浏览|搜索|搜一下|\b(?:open|visit|go\s+to|navigate|browse|search)\b/i,
  input: /填写|填入|填一下|填好|输入|点击|点一下|点开|勾选|选择|登录|登入|评论|回帖|提交|\b(?:fill|type|click|enter|select|log\s*in|sign\s*in|comment|submit|press)\b/i,
  publish: /发布|发表|发到|发至|发在|同步到|投稿|推送到|上架|\b(?:publish|post|tweet|share\s+to)\b/i,
  send: /发送|发给|寄给|转发给|回复|回信|私信|邮件|\b(?:send|e-?mail|mail\s+to|reply|forward|dm)\b/i,
  download: /下载|保存到本地|\bdownload\b/i,
  upload: /上传|附件|\b(?:upload|attach)\b/i,
  shell: /终端|命令行|(?:运行|执行)\s*(?:shell|bash|zsh|sh|cmd|脚本|命令|终端|本机命令)|\b(?:shell|terminal|bash)\b|\b(?:run|execute|exec)\s+(?:command|commands|script|shell|bash)\b/i,
  write: /保存|存到|存成|写入|记下|记到|笔记|收藏|书签|入库|\b(?:save|write|note|bookmark|remember)\b/i,
  clipboard: /复制|拷贝|剪贴板|\b(?:copy|clipboard)\b/i,
  close: /关闭|关掉|关了|\bclose\b/i,
  delete: /删除|删掉|清除|清空|移除|\b(?:delete|remove|clear|erase)\b/i,
  settings: /设置|配置|设定|偏好|主题|字体|深色|暗色|浅色|回答语言|切换模型|换个模型|\b(?:settings?|config|preference|theme|font)\b/i,
  automation: /automa|(?:运行|执行|调用|跑)\s*(?:工作流|workflow)|\bautoma\b/i,
  purchase: /购买|下单|付款|支付|结账|\b(?:buy|order|checkout|pay|purchase)\b/i,
};

const PROHIBIT_RE =
  /(?:绝对|严|切)?(?:禁止|严禁|切勿|请勿|不可|不得|不准|不许|不要|绝不|决不|禁按|禁点|勿点|勿按|不点击|不打开|不跳转|不保存|不提交|不发布|不发送|不上传|不删除|不关闭|\bdo\s+not\b|\bdon't\b|\bnever\b|\bmust\s+not\b|\bforbid(?:den)?\b)/i;
const PAREN_REMARK_RE = /[（(](?:[^（）()\n]|[（(][^（）()\n]{0,120}[）)]){1,300}[）)]/g;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`，。、；！？）】」』]+/gi;
const EMAIL_RE = /[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TLDS = "com|cn|net|org|io|dev|ai|app|co|me|tv|xyz|info|edu|gov|so|cc|jp|uk|de|fr|hk|tw|us|ly|gg|site|tech|top|vip|wiki|blog|news|page|cloud|link|im|to";
const DOMAIN_RE = new RegExp(`(?<![\\w.@/-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))(?::\\d+)?(?![\\w-])`, "gi");
const IPV4_RE = /(?<![\w.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?::\d+)?(?![\w.])/g;
const HANDLE_RE = /(?<![\w@])@([A-Za-z0-9_][\w.-]{1,38})/g;
const PATH_RE = /(?<![\w:/.~])((?:~\/|\/)(?:[\w.@%+=-]+\/?)+|[A-Za-z]:\\[^\s"'”」)）]+)/g;
const FENCE_RE = /```([\w-]*)[ \t]*\n?([\s\S]*?)```/g;
const SHELL_FENCE_LANG_RE = /^(?:sh|bash|zsh|shell|console|cmd|powershell|ps1)$/i;
const TICK_RE = /`([^`\n]+)`/g;
const DOLLAR_RE = /^[ \t]*\$[ \t]+(.+)$/gm;
const QUOTED_RUN_RE = /(?:运行|执行|跑一下|跑|run|execute|exec)\s*(?:本机)?(?:命令|脚本|终端)?\s*[:：]?\s*[“"「『]([^”"」』\n]+)[”"」』]/gi;
const RUN_TICK_CHAIN_RE =
  /(?:运行|执行|跑一下|跑|\brun\b|\bexecute\b|\bexec\b)\s*(?:本机)?(?:命令|脚本|终端)?\s*[:：]?\s*`[^`\n]+`(?:\s*(?:和|与|及|、|,|或|以及|然后|接着|顺便|并|再|\band\b|\bthen\b)\s*`[^`\n]+`)*/gi;
const FENCE_RUN_INTRO_RE = /(?:运行|执行|跑一下|跑|\brun\b|\bexecute\b|\bexec\b)\s*(?:本机)?(?:命令|脚本|终端)?\s*[:：]?\s*$/i;

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

/** 规范化命令用于逐字比对：去首尾空白、合并空白 */
export function normalizeCommand(cmd) {
  return String(cmd || "").trim().replace(/\s+/g, " ");
}

/** host / URL / origin → 规范域名（小写，去掉 www.） */
export function normalizeDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? urlHost(raw) : raw.toLowerCase().replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes(".") && host !== "localhost") return "";
  return host.replace(/^www\./, "");
}

export function hostMatchesDomain(host, domain) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const d = String(domain || "").toLowerCase();
  return Boolean(h && d) && (h === d || h.endsWith(`.${d}`));
}

export function emptyCapsule(principal = "user") {
  return {
    version: CAPSULE_VERSION,
    principal,
    actions: [],
    origins: [],
    urls: [],
    platforms: [],
    recipients: [],
    paths: [],
    commands: [],
    widened: false,
  };
}

function isPlausibleShellCommand(raw) {
  const cmd = normalizeCommand(String(raw || "").replace(/^\s*\$\s+/, ""));
  if (!cmd || cmd.length > 500) return false;
  // 排除 CSS 选择器（.class、#id、[attr]、>、+、*）、HTML 标签与注释
  if (/^(?:\.(?!\/)|#|\[|<|>|\+|~(?![/\\])|\*|:)/.test(cmd)) return false;
  // 排除纯 URL
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(cmd)) return false;
  // 排除无参数纯路径（可执行脚本或 bin 目录命令除外）
  if (
    /^(?:~\/|\/|[A-Za-z]:\\)\S+$/.test(cmd) &&
    !/\.(?:sh|bash|zsh|command|bat|cmd|ps1|py|mjs|cjs|js|rb|pl)$/i.test(cmd) &&
    !/(?:^|\/)s?bin\/[A-Za-z0-9._-]+$/.test(cmd)
  ) {
    return false;
  }
  const strippedEnv = cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");
  const firstToken = strippedEnv.split(/\s+/)[0] || "";
  if (!firstToken || !/[A-Za-z]/.test(firstToken)) return false;
  if (/[^\x21-\x7e]/.test(firstToken)) return false;
  if (/[\[\]#>+~:]/.test(firstToken)) return false;
  if (
    /^[a-z]+\.[a-z][\w.-]*$/i.test(firstToken) &&
    !/\.(?:sh|bash|zsh|command|bat|cmd|ps1|py|mjs|cjs|js|ts|rb|pl|exe|out|bin)$/i.test(firstToken)
  ) {
    return false;
  }
  return /^(?:\.{1,2}\/[\w./+-]+|~\/[\w./+-]+|\/[\w./+-]+|[A-Za-z][\w.+-]*)$/.test(firstToken);
}

function extractCommands(text, { hasShellIntent = false, allowBareTickCommands = false } = {}) {
  const out = [];
  let rest = text;
  rest = rest.replace(FENCE_RE, (_m, lang, body, offset, fullStr) => {
    if (lang && !SHELL_FENCE_LANG_RE.test(lang)) return " ";
    const prefix = String(fullStr || "").slice(Math.max(0, Number(offset) - 40), Number(offset));
    const fenceIntro = FENCE_RUN_INTRO_RE.test(prefix);
    for (const line of String(body).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const hasDollar = /^\$\s+/.test(trimmed);
      const cmd = trimmed.replace(/^\$\s+/, "").trim();
      if ((hasDollar || hasShellIntent || fenceIntro) && isPlausibleShellCommand(cmd)) {
        out.push(cmd);
      }
    }
    return " ";
  });
  for (const m of rest.matchAll(TICK_RE)) {
    if (/^\s*\$\s+\S/.test(m[1])) {
      const cmd = m[1].replace(/^\s*\$\s+/, "");
      if (isPlausibleShellCommand(cmd)) out.push(cmd);
    }
  }
  for (const chain of rest.matchAll(RUN_TICK_CHAIN_RE)) {
    for (const tm of chain[0].matchAll(TICK_RE)) {
      const cmd = tm[1].replace(/^\s*\$\s+/, "");
      if (isPlausibleShellCommand(cmd)) out.push(cmd);
    }
  }
  if (hasShellIntent || allowBareTickCommands) {
    for (const m of rest.matchAll(TICK_RE)) {
      const cmd = m[1].replace(/^\s*\$\s+/, "");
      if (isPlausibleShellCommand(cmd)) out.push(cmd);
    }
  }
  for (const m of rest.matchAll(DOLLAR_RE)) {
    if (isPlausibleShellCommand(m[1])) out.push(m[1]);
  }
  for (const m of rest.matchAll(QUOTED_RUN_RE)) {
    const cmd = m[1].replace(/^\s*\$\s+/, "");
    if (isPlausibleShellCommand(cmd)) out.push(cmd);
  }
  return uniq(out.map(normalizeCommand).filter((c) => c.length <= 500));
}

/** 剥离委托人明确表达禁止/否定的括号备注与分句，防止禁令中的动作词或域名误入授权胶囊 */
export function stripProhibitedClauses(raw) {
  const input = String(raw || "");
  if (!input) return "";
  const fences = [];
  let text = input.replace(FENCE_RE, (m) => {
    const idx = fences.push(m) - 1;
    return `__PL_FENCE_${idx}__`;
  });
  text = text.replace(PAREN_REMARK_RE, (m) => (PROHIBIT_RE.test(m) ? " " : m));
  const parts = text.split(/([\n。！？!?；;，,])/);
  const kept = parts.map((part, idx) => {
    if (idx % 2 === 1) return part;
    const hit = PROHIBIT_RE.exec(part);
    return hit ? part.slice(0, hit.index) : part;
  });
  return kept
    .join("")
    .replace(/__PL_FENCE_(\d+)__/g, (_m, i) => fences[Number(i)] || "");
}

const READ_ONLY_WORKFLOW_OPS = new Set([
  "assert_url",
  "wait_for",
  "scroll_container",
  "assert_state",
  "query_dom",
  "set_binds",
  "fail",
  "noop",
]);

const NAVIGATE_WORKFLOW_OPS = new Set([
  "navigate",
  "open_tab",
]);

function collectWorkflowStrings(node, out, depth = 0) {
  if (depth > 14 || node == null) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectWorkflowStrings(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const [k, val] of Object.entries(node)) {
      if (/^forbid/i.test(k) || k === "policy") continue;
      collectWorkflowStrings(val, out, depth + 1);
    }
  }
}

function collectWorkflowStepActions(steps, macros, actionSet, visitedMacros = new Set(), depth = 0) {
  if (!Array.isArray(steps) || depth > 12) return;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const op = String(step.op || "").trim().toLowerCase();
    const params = step.params && typeof step.params === "object" ? step.params : {};

    for (const nestedKey of ["steps", "thenSteps", "elseSteps", "then", "else"]) {
      if (Array.isArray(step[nestedKey])) {
        collectWorkflowStepActions(step[nestedKey], macros, actionSet, visitedMacros, depth + 1);
      }
      if (Array.isArray(params[nestedKey])) {
        collectWorkflowStepActions(params[nestedKey], macros, actionSet, visitedMacros, depth + 1);
      }
    }

    if (!op || op === "if_state" || op === "foreach") continue;

    if (op === "call_macro") {
      const macroName = String(step.macro || params.macro || "").trim();
      const macroDef = macroName && macros && typeof macros === "object" ? macros[macroName] : null;
      const macroSteps = Array.isArray(macroDef) ? macroDef : macroDef?.steps;
      if (Array.isArray(macroSteps) && !visitedMacros.has(macroName)) {
        visitedMacros.add(macroName);
        collectWorkflowStepActions(macroSteps, macros, actionSet, visitedMacros, depth + 1);
      } else if (!Array.isArray(macroSteps)) {
        actionSet.add("input");
      }
      continue;
    }

    if (op === "assert_url") {
      if (params.recoverUrl || params.autoNavigate) actionSet.add("navigate");
      continue;
    }
    if (READ_ONLY_WORKFLOW_OPS.has(op)) continue;
    if (NAVIGATE_WORKFLOW_OPS.has(op)) {
      actionSet.add("navigate");
      continue;
    }
    if (params.openUrl) {
      actionSet.add("navigate");
    }
    if (op === "upload_file") {
      actionSet.add("upload");
      continue;
    }
    if (op === "download_file") {
      actionSet.add("download");
      continue;
    }
    if (op === "close_tab") {
      actionSet.add("close");
      continue;
    }
    actionSet.add("input");
  }
}

function extractWorkflowCapsule(rawText, principal = "user") {
  const raw = String(rawText || "");
  if (!/^\s*\/workflow(?:\s|$)/i.test(raw)) return null;
  const capsule = emptyCapsule(principal);
  let body = raw.replace(/^\s*\/workflow\b/i, "").trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  if (!body) return capsule;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return capsule;
  }
  if (!parsed || typeof parsed !== "object") return capsule;
  const candidateStrings = [];
  if (parsed.binds && typeof parsed.binds === "object") {
    collectWorkflowStrings(parsed.binds, candidateStrings);
  }
  if (Array.isArray(parsed.steps)) {
    collectWorkflowStrings(parsed.steps, candidateStrings);
  }
  if (parsed.macros && typeof parsed.macros === "object") {
    collectWorkflowStrings(parsed.macros, candidateStrings);
  }
  const joined = candidateStrings.join("\n");
  const urls = uniq(
    [...joined.matchAll(URL_RE)]
      .map((m) => m[0].replace(/[.,;:!?]+$/, ""))
      .filter((u) => urlOrigin(u)),
  );
  const actionSet = new Set();
  collectWorkflowStepActions(parsed.steps, parsed.macros, actionSet);
  capsule.actions = ACTION_CATEGORIES.filter((a) => actionSet.has(a));
  capsule.urls = urls;
  capsule.origins = uniq(urls.map(normalizeDomain));
  return capsule;
}

/**
 * 从委托人指令确定性地抽取胶囊。只能传用户/委托人本人写的文字，不能拼入页面内容。
 * @param {string} text
 * @param {{ principal?: "user"|"agent" }} [opts]
 */
export function extractCapsule(text, { principal = "user", allowBareTickCommands = false } = {}) {
  const wfCapsule = extractWorkflowCapsule(text, principal);
  if (wfCapsule) return wfCapsule;
  const capsule = emptyCapsule(principal);
  const src = String(text || "").slice(0, 20000);
  if (!src.trim()) return capsule;

  const affirmativeSrc = stripProhibitedClauses(src);
  const actionSrc = affirmativeSrc
    .replace(FENCE_RE, (m, lang) => (lang && !SHELL_FENCE_LANG_RE.test(lang) ? " " : m))
    .replace(TICK_RE, (m, inner) => (/^\s*(?:\.(?!\/)|#|\[|<|>)/.test(inner) ? " " : m));
  const hasShellIntent = ACTION_KEYWORDS.shell.test(actionSrc);

  const commands = extractCommands(affirmativeSrc, { hasShellIntent, allowBareTickCommands });
  const urls = uniq([...affirmativeSrc.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, "")).filter((u) => urlOrigin(u)));
  const emails = uniq([...affirmativeSrc.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()));
  const noUrls = affirmativeSrc.replace(URL_RE, " ").replace(EMAIL_RE, " ");
  const domains = [...noUrls.matchAll(DOMAIN_RE)].map((m) => normalizeDomain(m[1]));
  const ipv4Hosts = [...noUrls.matchAll(IPV4_RE)].map((m) => normalizeDomain(m[1]));
  const handles = [...noUrls.matchAll(HANDLE_RE)].map((m) => `@${m[1]}`);
  const pathSrc = affirmativeSrc.replace(URL_RE, " ");
  const paths = uniq([...pathSrc.matchAll(PATH_RE)].map((m) => m[1].replace(/[.,;:!?]+$/, "")).filter((p) => p.length > 1));

  const platforms = KNOWN_PLATFORMS.filter((p) => p.re.test(affirmativeSrc));
  const actions = ACTION_CATEGORIES.filter((a) => ACTION_KEYWORDS[a]?.test(actionSrc));
  if (urls.length && !actions.includes("navigate")) actions.push("navigate");
  if (commands.length && !actions.includes("shell")) actions.push("shell");

  capsule.actions = actions;
  capsule.urls = urls;
  capsule.origins = uniq([
    ...urls.map(normalizeDomain),
    ...domains,
    ...ipv4Hosts,
    ...platforms.flatMap((p) => p.domains),
  ]);
  capsule.platforms = platforms.map((p) => p.id);
  capsule.recipients = uniq([...emails, ...handles]);
  capsule.paths = paths;
  capsule.commands = commands;
  return capsule;
}

function stringList(raw, map = (x) => String(x || "").trim()) {
  return Array.isArray(raw) ? uniq(raw.map(map)) : [];
}

/** 校验外部传入的显式胶囊（P5 委托任务）；未知字段与非法值丢弃 */
export function normalizeCapsule(raw, { principal } = {}) {
  const c = emptyCapsule(principal || (raw?.principal === "agent" ? "agent" : "user"));
  if (!raw || typeof raw !== "object") return c;
  c.actions = stringList(raw.actions).filter((a) => ACTION_CATEGORIES.includes(a));
  c.urls = stringList(raw.urls).filter((u) => urlOrigin(u));
  c.origins = uniq([...stringList(raw.origins, normalizeDomain), ...c.urls.map(normalizeDomain)]);
  c.platforms = stringList(raw.platforms).filter((p) => PLATFORM_BY_ID.has(p));
  for (const id of c.platforms) c.origins = uniq([...c.origins, ...PLATFORM_BY_ID.get(id).domains]);
  c.recipients = stringList(raw.recipients).slice(0, 50);
  c.paths = stringList(raw.paths).filter((p) => /^(?:~|\/|[A-Za-z]:\\)/.test(p) && !p.split(/[/\\]/).includes(".."));
  c.commands = stringList(raw.commands, normalizeCommand).filter((x) => x.length <= 500);
  c.widened = raw.widened === true;
  return c;
}

/** 合并两个胶囊（多轮对话里委托人的授权累加） */
export function mergeCapsules(a, b) {
  if (!a) return b ? normalizeCapsule(b, { principal: b.principal }) : emptyCapsule();
  if (!b) return a;
  return {
    version: CAPSULE_VERSION,
    principal: a.principal === "user" || b.principal === "user" ? "user" : "agent",
    actions: ACTION_CATEGORIES.filter((x) => a.actions.includes(x) || b.actions.includes(x)),
    origins: uniq([...a.origins, ...b.origins]),
    urls: uniq([...a.urls, ...b.urls]),
    platforms: uniq([...a.platforms, ...b.platforms]),
    recipients: uniq([...a.recipients, ...b.recipients]),
    paths: uniq([...a.paths, ...b.paths]),
    commands: uniq([...a.commands, ...b.commands]),
    widened: Boolean(a.widened || b.widened),
  };
}

/**
 * 用户在侧栏手动扩大授权。additions 里的 text 按委托人指令抽取（每行可写域名、URL、`$ 命令`）。
 */
export function widenCapsule(capsule, { actions = [], text = "" } = {}) {
  const fromText = extractCapsule(text, { allowBareTickCommands: true });
  fromText.actions = [];
  const extra = normalizeCapsule({ ...fromText, actions });
  extra.widened = true;
  return mergeCapsules(capsule || emptyCapsule(), extra);
}

/** 用户在侧栏收窄授权：取消勾选的类别 */
export function setCapsuleActions(capsule, actions) {
  const base = capsule || emptyCapsule();
  return { ...base, actions: ACTION_CATEGORIES.filter((a) => actions.includes(a)), widened: true };
}

export const ACTION_LABELS = {
  navigate: "打开/跳转",
  input: "填写/点击",
  publish: "发布",
  send: "发送",
  download: "下载",
  upload: "上传",
  shell: "本机命令",
  write: "保存笔记/书签",
  clipboard: "剪贴板",
  close: "关闭标签",
  delete: "删除",
  settings: "改设置",
  automation: "自动化工作流",
  purchase: "购买/支付",
};

/** 给用户看的胶囊摘要 */
export function describeCapsule(capsule) {
  const c = capsule || emptyCapsule();
  const parts = [];
  parts.push(c.actions.length ? `动作：${c.actions.map((a) => ACTION_LABELS[a] || a).join("、")}` : "动作：仅阅读");
  if (c.origins.length) parts.push(`站点：${c.origins.join("、")}`);
  if (c.platforms.length) parts.push(`平台：${c.platforms.join("、")}`);
  if (c.recipients.length) parts.push(`收件人：${c.recipients.join("、")}`);
  if (c.paths.length) parts.push(`路径：${c.paths.join("、")}`);
  if (c.commands.length) parts.push(`命令：${c.commands.map((x) => `\`${x}\``).join("、")}`);
  return parts;
}

function originInCapsule(capsule, url) {
  const host = urlHost(url);
  return Boolean(host) && capsule.origins.some((d) => hostMatchesDomain(host, d));
}

function sameOrigin(a, b) {
  const x = urlOrigin(a);
  return Boolean(x) && x === urlOrigin(b);
}

function pathUnder(path, roots) {
  const p = String(path || "");
  if (!p || p.split(/[/\\]/).includes("..")) return false;
  return roots.some((r) => {
    const root = String(r).replace(/[/\\]+$/, "");
    return p === root || p.startsWith(`${root}/`) || p.startsWith(`${root}\\`);
  });
}

/** 对平台 id 或域名判断胶囊是否声明了该发布目标 */
export function platformInCapsule(capsule, platform) {
  const id = String(platform || "").toLowerCase();
  if (capsule.platforms.includes(id)) return true;
  const known = PLATFORM_BY_ID.get(id);
  return Boolean(known && known.domains.some((d) => capsule.origins.some((o) => hostMatchesDomain(d, o))));
}

export function platformDomains(platform) {
  return PLATFORM_BY_ID.get(String(platform || "").toLowerCase())?.domains || [];
}

/**
 * 工具调用是否落在胶囊内。
 * @returns {{ covered: boolean, why: string }}
 */
export function capsuleCovers(capsule, { toolName, args = {}, targetUrl = "", sourceUrl = "" } = {}) {
  if (!capsule) return { covered: false, why: "没有授权胶囊" };
  const category = toolCategory(toolName, args);
  const has = (a) => capsule.actions.includes(a);
  const target = targetUrl || String(args?.url || "");
  switch (category) {
    case "read":
      return { covered: true, why: "只读" };
    case "navigate": {
      if (toolName === "web_search") return { covered: has("navigate"), why: "搜索" };
      if (!target) return { covered: false, why: "目标未知" };
      if (capsule.urls.includes(target) || originInCapsule(capsule, target)) return { covered: true, why: `打开 ${urlHost(target)}` };
      if ((toolName === "switch_tab" || toolName === "reload_tab") && sameOrigin(target, sourceUrl)) return { covered: true, why: "当前任务页" };
      return { covered: false, why: `${urlHost(target) || "目标"} 不在授权站点里` };
    }
    case "input": {
      if (!has("input") && !has("publish") && !has("send")) return { covered: false, why: "未授权页面输入" };
      if (!target) return { covered: false, why: "目标页未知" };
      if (originInCapsule(capsule, target) || sameOrigin(target, sourceUrl)) return { covered: true, why: `在 ${urlHost(target)} 操作` };
      return { covered: false, why: `${urlHost(target) || "目标页"} 不在授权站点里` };
    }
    case "publish": {
      if (!has("publish")) return { covered: false, why: "未授权发布" };
      const platforms = Array.isArray(args?.platforms) ? args.platforms : [];
      if (!platforms.length) return { covered: false, why: "发布平台未知" };
      const missing = platforms.filter((p) => !platformInCapsule(capsule, p));
      return missing.length ? { covered: false, why: `平台 ${missing.join("、")} 未授权` } : { covered: true, why: "发布到授权平台" };
    }
    case "download": {
      if (!has("download")) return { covered: false, why: "未授权下载" };
      const url = String(args?.url || target);
      if (!url && toolName === "save_page_mhtml") return { covered: true, why: "保存当前页" };
      return originInCapsule(capsule, url) || sameOrigin(url, sourceUrl)
        ? { covered: true, why: "从授权站点下载" }
        : { covered: false, why: `${urlHost(url) || "下载地址"} 不在授权站点里` };
    }
    case "upload": {
      if (!has("upload")) return { covered: false, why: "未授权上传" };
      const paths = Array.isArray(args?.paths) ? args.paths.map(String) : [];
      return paths.length && paths.every((p) => pathUnder(p, capsule.paths))
        ? { covered: true, why: "上传授权路径" }
        : { covered: false, why: "上传文件不在授权路径里" };
    }
    case "shell": {
      const cmd = normalizeCommand(args?.command);
      return cmd && capsule.commands.includes(cmd)
        ? { covered: true, why: "命令出自委托人原文" }
        : { covered: false, why: "命令不是委托人原文" };
    }
    case "write":
      return has("write") ? { covered: true, why: "授权保存" } : { covered: false, why: "未授权写入" };
    case "clipboard":
      return has("clipboard") || has("write") ? { covered: true, why: "授权剪贴板" } : { covered: false, why: "未授权剪贴板" };
    case "close":
      return has("close") ? { covered: true, why: "授权关闭" } : { covered: false, why: "未授权关闭标签" };
    case "delete":
      return has("delete") ? { covered: true, why: "授权删除" } : { covered: false, why: "未授权删除" };
    case "settings":
      return has("settings") ? { covered: true, why: "授权改设置" } : { covered: false, why: "未授权改设置" };
    case "automation":
      return has("automation") ? { covered: true, why: "授权工作流" } : { covered: false, why: "未授权工作流" };
    default:
      return { covered: false, why: "未分类工具" };
  }
}
