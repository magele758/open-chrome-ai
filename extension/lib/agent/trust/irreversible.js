/**
 * 不可逆动作清单：用户声明“我要亲自过目”的动作。命中即确认，与来源、胶囊、确认模式无关；
 * 无人值守时返回 CONFIRMATION_REQUIRED 进入待批准队列。清单本身是安全设置，Agent 不能修改。
 */

export const IRREVERSIBLE_ITEMS = Object.freeze([
  { id: "publish_send", label: "发布 / 发送 / 提交订单（COSE 发布、「发表」「发送」「提交订单」类按钮）" },
  { id: "delete", label: "删除（批量关闭标签、chrome_call 删除类方法、「删除」类按钮）" },
  { id: "executable_download", label: "下载可执行文件（exe / dmg / pkg / sh 等）" },
  { id: "file_upload", label: "上传本机文件到网页" },
  { id: "shell_write", label: "本机命令写操作（rm / mv / 重定向覆盖 / chmod / git push 等）" },
  { id: "settings_change", label: "修改 PageLens 设置" },
  { id: "checkout_pay", label: "付款 / 结账页面上的操作（checkout、pay、cashier 类网址）" },
]);

export const IRREVERSIBLE_IDS = IRREVERSIBLE_ITEMS.map((i) => i.id);

export function defaultIrreversibleActions() {
  return Object.fromEntries(IRREVERSIBLE_IDS.map((id) => [id, true]));
}

/** 只认已知 id；缺省项按默认勾选 */
export function normalizeIrreversibleActions(raw) {
  const out = defaultIrreversibleActions();
  if (raw && typeof raw === "object") {
    for (const id of IRREVERSIBLE_IDS) if (typeof raw[id] === "boolean") out[id] = raw[id];
  }
  return out;
}

function enabledMap(settings) {
  return normalizeIrreversibleActions(settings?.irreversibleActions);
}

const PUBLISH_TEXT_RE =
  /(发布|发表|发送|群发|提交订单|确认订单|立即购买|立即下单|确认支付|确认付款|立即支付|去支付|\b(?:publish|post|send|tweet|submit\s+order|place\s+(?:your\s+)?order|buy\s+now|pay\s+now|confirm\s+(?:payment|purchase|order)|checkout)\b)/i;
const DELETE_TEXT_RE = /(删除|永久删除|清空|注销|移除|\b(?:delete|remove|erase|destroy|empty\s+trash)\b)/i;
const EXECUTABLE_RE = /\.(?:exe|msi|msix|dmg|pkg|app|deb|rpm|apk|ipa|sh|bash|zsh|command|bat|cmd|ps1|vbs|jar|scr|run|bin|appimage)$/i;
const CHECKOUT_RE = /(?:^|[./_-])(?:checkout|pay|payment|payments|cashier|billing|purchase|order[-_]?confirm|收银台|支付)(?:$|[./_?#-])/i;

const SHELL_WRITE_PATTERNS = [
  /(?:^|[\s;&|(`])(?:sudo\s+)?(?:rm|rmdir|mv|dd|shred|truncate|chmod|chown|chgrp|unlink|kill|killall|pkill|reboot|shutdown|halt|crontab|launchctl|systemctl|diskutil|mkfs(?:\.\w+)?)(?=\s|$)/i,
  /(?:^|[^0-9&>=-])>{1,2}(?![&=])\s*(?!\/dev\/null\b)[^\s&|;]/,
  /(?:^|[\s;&|(`])tee(?=\s|$)/,
  /\bsed\s+(?:-[a-zA-Z]*i|--in-place)/,
  /\bperl\s+-[a-zA-Z]*i/,
  /\bfind\b[^|;&]*\s-(?:delete|exec\s+rm)\b/,
  /\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--|restore|branch\s+-[dD]\b|rebase|commit\s+--amend|filter-branch|stash\s+(?:drop|clear)|tag\s+-d)/,
  /\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b|\bpip3?\s+uninstall\b|\bbrew\s+uninstall\b/,
];

/** 只读判断，不解析 shell；宁可多确认 */
export function isShellWrite(command) {
  const s = String(command || "");
  return SHELL_WRITE_PATTERNS.some((re) => re.test(s));
}

function urlPathOf(url) {
  try {
    const u = new URL(String(url || ""));
    return { host: u.hostname, path: u.pathname };
  } catch {
    return { host: "", path: String(url || "") };
  }
}

export function isCheckoutUrl(url) {
  const { host, path } = urlPathOf(url);
  if (!host && !path) return false;
  return CHECKOUT_RE.test(host) || CHECKOUT_RE.test(path);
}

export function isExecutableDownload(url, filename) {
  const { path } = urlPathOf(url);
  return EXECUTABLE_RE.test(path) || EXECUTABLE_RE.test(String(filename || ""));
}

const CLICK_TOOLS = new Set(["click", "trusted_click", "act_element"]);
const PAGE_ACT_TOOLS = new Set([
  "click", "trusted_click", "act_element", "fill", "trusted_type", "press_key", "press_keys",
  "select_option", "paste_into_page", "run_js", "drag_drop",
]);

/**
 * 命中的清单项。ctx.elementText：act_element / 按编号点击时控件的可见文字；ctx.targetUrl：目标标签 URL。
 * @returns {{ id: string, label: string, reason: string } | null}
 */
export function matchIrreversible(toolName, args = {}, settings = {}, ctx = {}) {
  const on = enabledMap(settings);
  const item = (id, reason) => (on[id] ? { id, label: IRREVERSIBLE_ITEMS.find((i) => i.id === id).label, reason } : null);
  const hits = [];
  const buttonText = [args?.text, ctx.elementText].filter((x) => typeof x === "string" && x.trim()).join(" ").slice(0, 200);
  const isClick = CLICK_TOOLS.has(toolName) && (toolName !== "act_element" || String(args?.action || "") === "click");

  if (toolName === "cose_publish") hits.push(item("publish_send", "COSE 发布到外部平台"));
  if (isClick && buttonText && PUBLISH_TEXT_RE.test(buttonText)) hits.push(item("publish_send", `点击「${buttonText.slice(0, 40)}」`));

  if (toolName === "close_task_group") hits.push(item("delete", "批量关闭任务分组标签"));
  if (toolName === "chrome_call" && /remove|delete|clear/i.test(String(args?.method || ""))) {
    hits.push(item("delete", `chrome_call ${args.method}`));
  }
  if (toolName === "write_library" && ctx.overwrite === true) hits.push(item("delete", "覆盖已有文稿"));
  if (isClick && buttonText && DELETE_TEXT_RE.test(buttonText)) hits.push(item("delete", `点击「${buttonText.slice(0, 40)}」`));

  if (toolName === "download_file" && isExecutableDownload(args?.url, args?.filename)) {
    hits.push(item("executable_download", "下载可执行文件"));
  }
  if (toolName === "upload_file") hits.push(item("file_upload", "把本机文件交给网页"));
  if (toolName === "run_shell" && isShellWrite(args?.command)) hits.push(item("shell_write", "命令会删除、移动或覆盖本机内容"));
  if (toolName === "update_settings") hits.push(item("settings_change", "修改 PageLens 设置"));

  const navUrl = toolName === "open_tab" || toolName === "navigate_tab" ? String(args?.url || "") : "";
  if (navUrl && isCheckoutUrl(navUrl)) hits.push(item("checkout_pay", "打开付款/结账页面"));
  if (PAGE_ACT_TOOLS.has(toolName) && ctx.targetUrl && isCheckoutUrl(ctx.targetUrl)) {
    hits.push(item("checkout_pay", "在付款/结账页面上操作"));
  }
  return hits.find(Boolean) || null;
}

/** 纯函数：该调用是否命中用户的不可逆清单 */
export function isIrreversible(toolName, args = {}, settings = {}, ctx = {}) {
  return matchIrreversible(toolName, args, settings, ctx) !== null;
}
