/**
 * 出站守卫（始终开启，与来源无关）：数据只能流向委托人声明过的目的地。
 * 允许 = 胶囊目标 ∪ token 出站白名单 ∪ 当前任务源 origin（∪ 本会话用户已放行的 origin）。
 * 会话高污染时收紧为：胶囊目标 ∪ token 白名单（胶囊授权了页面输入时再加源 origin）。
 * 纯函数，侧栏拦截器与 bridge 共用；超出即 EGRESS_NOT_ALLOWED。
 */
import { isUrlAllowed } from "../bridge/policy.js";
import { hostMatchesDomain, platformDomains } from "./trust/capsule.js";
import { TAINT_HIGH, taintLevel } from "./trust/taint.js";
import { urlHost, urlOrigin } from "./trust/tool-classes.js";
import { isSensitivePath } from "./shell-policy.js";

export const EGRESS_NOT_ALLOWED = "EGRESS_NOT_ALLOWED";
export const SENSITIVE_PATH = "SENSITIVE_PATH";

/**
 * @param {{ capsule?: object, tokenEgress?: string[], sourceUrl?: string, approvedOrigins?: Set<string>|string[], taint?: any }} opts
 */
export function buildEgressPolicy({ capsule = null, tokenEgress = [], sourceUrl = "", approvedOrigins = null, taint = null } = {}) {
  const high = taintLevel(taint) === TAINT_HIGH;
  const domains = capsule?.origins || [];
  const capsuleInput = Boolean(capsule?.actions?.some((a) => a === "input" || a === "publish" || a === "send"));
  const source = urlOrigin(sourceUrl);
  const approved = new Set(approvedOrigins ? [...approvedOrigins] : []);
  const includeSource = Boolean(source) && (!high || capsuleInput);
  const includeApproved = !high;
  return {
    high,
    isAllowed(url) {
      const raw = String(url || "");
      const target = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
      const origin = urlOrigin(target);
      const host = urlHost(target);
      if (!origin || !host) return false;
      if (domains.some((d) => hostMatchesDomain(host, d))) return true;
      if (isUrlAllowed(target, tokenEgress) || isUrlAllowed(target.replace(/^https:/, "http:"), tokenEgress)) return true;
      if (includeSource && origin === source) return true;
      if (includeApproved && approved.has(origin)) return true;
      return false;
    },
  };
}

/** URL 是否可能夹带数据：查询串、片段、凭据、超长路径段或超长子域 */
export function urlCarriesPayload(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.search.length > 1 || u.hash.length > 1 || u.username || u.password) return true;
    if (u.pathname.split("/").some((seg) => seg.length >= 48)) return true;
    return u.hostname.split(".").some((label) => label.length >= 40);
  } catch {
    return true;
  }
}

const NETWORK_JS_RE =
  /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|RTCPeerConnection|importScripts)\b|\bimport\s*\(|\.\s*(?:src|href|action)\s*=(?!=)|\blocation\s*(?:\.\s*\w+\s*)?=(?!=)|\bwindow\s*\.\s*open\b|\.\s*submit\s*\(|\.\s*requestSubmit\s*\(/;
const JS_URL_RE = /["'`]((?:https?:)?\/\/[^"'`\s]+)["'`]/g;

/** run_js 代码里可能的外发目的地；无法静态确定时 dynamic=true */
export function runJsDestinations(code, baseUrl = "") {
  const s = String(code || "");
  if (!NETWORK_JS_RE.test(s)) return { network: false, urls: [], dynamic: false };
  const urls = [...s.matchAll(JS_URL_RE)].map((m) => (m[1].startsWith("//") ? `https:${m[1]}` : m[1]));
  const relative = /["'`]\/(?!\/)[^"'`\s]*["'`]/.test(s) && urlOrigin(baseUrl);
  return { network: true, urls, dynamic: urls.length === 0 && !relative };
}

const NET_BINS = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "scp", "sftp", "rsync", "ssh", "ftp", "tftp", "telnet",
  "socat", "http", "https", "xh", "aria2c", "lftp", "smbclient", "httpie",
]);
const SHELL_URL_RE = /\b(?:https?|ftp|wss?):\/\/[^\s"'`|;&<>)]+/gi;

function shellTokens(command) {
  return String(command || "").split(/[\s;&|()`]+/).map((t) => t.replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** shell 命令的网络目的地；network=true 且 hosts 为空表示目的地不明 */
export function shellNetworkDestinations(command) {
  const s = String(command || "");
  const tokens = shellTokens(s);
  const hosts = new Set();
  for (const m of s.matchAll(SHELL_URL_RE)) {
    const host = urlHost(m[0].replace(/^(?:ftp|wss?):/i, "https:"));
    if (host) hosts.add(host);
  }
  let network = hosts.size > 0 || /\/dev\/(?:tcp|udp)\//.test(s);
  for (let i = 0; i < tokens.length; i += 1) {
    const bin = tokens[i].split("/").pop();
    if (!NET_BINS.has(bin)) continue;
    network = true;
    for (const t of tokens.slice(i + 1)) {
      if (t.startsWith("-")) continue;
      const remote = /^(?:[\w.-]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+):/.exec(t);
      if (remote) hosts.add(remote[1].toLowerCase());
      else if (["ssh", "nc", "ncat", "netcat", "telnet", "sftp", "ftp", "socat"].includes(bin)) {
        const bare = /^(?:[\w.-]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+)$/.exec(t);
        if (bare) hosts.add(bare[1].toLowerCase());
      }
    }
  }
  return { network, hosts: [...hosts] };
}

const INPUT_DATA_TOOLS = new Set(["fill", "trusted_type", "paste_into_page"]);

function hit(channel, destination, reason) {
  return { ok: false, code: EGRESS_NOT_ALLOWED, channel, destination: destination || "", origin: urlOrigin(destination) || "", reason };
}

/**
 * 判断一次工具调用是否把数据送往未声明的目的地。
 * @param {string} toolName
 * @param {object} args
 * @param {{ targetUrl?: string, policy: ReturnType<typeof buildEgressPolicy> }} ctx
 */
export function checkEgress(toolName, args = {}, { targetUrl = "", policy } = {}) {
  const allowed = (url) => Boolean(policy?.isAllowed(url));
  const where = (url) => urlHost(url) || String(url || "未知目的地").slice(0, 80);
  switch (toolName) {
    case "open_tab":
    case "navigate_tab":
    case "download_file": {
      const url = String(args?.url || targetUrl || "").trim();
      if (!url || allowed(url) || !urlCarriesPayload(url)) return { ok: true };
      return hit(toolName === "download_file" ? "download" : "navigation", url, `带参数的地址指向未声明的目的地 ${where(url)}`);
    }
    case "run_js": {
      if (targetUrl && !allowed(targetUrl)) return hit("script", targetUrl, `跨源操作：在未声明的站点 ${where(targetUrl)} 执行脚本`);
      if (!targetUrl) return hit("script", "", "执行脚本的目标页未知");
      const dest = runJsDestinations(args?.code, targetUrl);
      if (!dest.network) return { ok: true };
      if (dest.dynamic) return hit("script_network", "", "脚本会发起网络请求，目的地无法静态确定");
      const bad = dest.urls.find((u) => !allowed(u));
      return bad ? hit("script_network", bad, `脚本会向未声明的目的地 ${where(bad)} 发请求`) : { ok: true };
    }
    case "act_element": {
      if (!["fill", "select"].includes(String(args?.action || ""))) return { ok: true };
      if (targetUrl && allowed(targetUrl)) return { ok: true };
      return hit("input", targetUrl, `跨源操作：向未声明的站点 ${where(targetUrl)} 输入内容`);
    }
    case "run_shell": {
      const { network, hosts } = shellNetworkDestinations(args?.command);
      if (!network) return { ok: true };
      if (!hosts.length) return hit("shell_network", "", "命令会访问网络，目的地无法确定");
      const bad = hosts.find((h) => !allowed(h));
      return bad ? hit("shell_network", `https://${bad}`, `命令会访问未声明的主机 ${bad}`) : { ok: true };
    }
    case "cose_publish": {
      const platforms = Array.isArray(args?.platforms) ? args.platforms : [];
      const bad = platforms.find((p) => {
        const domains = platformDomains(p);
        return !domains.length || !domains.some((d) => allowed(`https://${d}`));
      });
      return bad ? hit("publish", "", `发布平台 ${bad} 不在声明的目的地里`) : { ok: true };
    }
    default:
      if (INPUT_DATA_TOOLS.has(toolName)) {
        if (targetUrl && allowed(targetUrl)) return { ok: true };
        return hit("input", targetUrl, `跨源操作：向未声明的站点 ${where(targetUrl)} 输入内容`);
      }
      return { ok: true };
  }
}

const PATH_TOKEN_RE = /[^\s"'`|;&<>()=]+/g;

/**
 * 敏感本机路径（.ssh / .aws / .env / *.pem …）硬规则，对所有来源生效。
 * @returns {{ ok: true } | { ok: false, code: "SENSITIVE_PATH", path: string, hard: boolean, reason: string }}
 */
export function checkSensitivePaths(toolName, args = {}) {
  let candidates = [];
  if (toolName === "upload_file") candidates = Array.isArray(args?.paths) ? args.paths.map(String) : [];
  else if (toolName === "run_shell") {
    candidates = [...String(args?.command || "").matchAll(PATH_TOKEN_RE)].map((m) => m[0]);
    if (args?.cwd) candidates.push(String(args.cwd));
  } else if (toolName === "read_file" || toolName === "list_directory") {
    candidates = [args?.path, args?.dir, args?.file].filter(Boolean).map(String);
  }
  const bad = candidates.find((p) => isSensitivePath(p));
  if (!bad) return { ok: true };
  const hard = toolName === "upload_file";
  return {
    ok: false,
    code: SENSITIVE_PATH,
    path: bad,
    hard,
    reason: hard ? `拒绝把敏感文件 ${bad} 上传到网页` : `涉及敏感本机路径 ${bad}`,
  };
}
