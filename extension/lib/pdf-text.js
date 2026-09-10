/**
 * Fetch a PDF in the extension context (host_permissions bypass CORS)
 * and turn the text layer into page-pack copy. Page injection cannot do this:
 * Chrome's PDF viewer has no paper text, and alphaXiv's /pdf/ URL is HTML.
 */

export const PDF_MAX_CHARS = 24000;
export const PDF_MAX_PAGES = 40;
export const PDF_MAX_BYTES = 25 * 1024 * 1024;
export const PDF_FETCH_MS = 25000;

let pdfjsMod = null;

export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function paperIdFromUrl(url) {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const neu = path.match(/(\d{4}\.\d{4,5})(?:v\d+)?/);
    if (neu) return neu[1];
    const old = path.match(/((?:[a-z-]+\/)\d{7})/i);
    if (old) return old[1];
  } catch {
    /* ignore */
  }
  const neu = String(url || "").match(/(\d{4}\.\d{4,5})(?:v\d+)?/);
  return neu ? neu[1] : "";
}

function htmlPdfViewerHost(hostname) {
  const h = String(hostname || "")
    .replace(/^www\./, "")
    .toLowerCase();
  return h === "alphaxiv.org" || h.endsWith(".alphaxiv.org");
}

export function isPaperHost(hostname, url = "") {
  const h = String(hostname || "")
    .replace(/^www\./, "")
    .toLowerCase();
  if (/(^|\.)(arxiv\.org|alphaxiv\.org|openreview\.net|biorxiv\.org|medrxiv\.org|aclanthology\.org)$/.test(h)) {
    return true;
  }
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  })();
  if (h === "huggingface.co" && /\/papers\//.test(path)) return true;
  if (h === "paperswithcode.com" && /\/paper\//.test(path)) return true;
  if (h === "semanticscholar.org" && /\/paper\//.test(path)) return true;
  return false;
}

export function looksLikePdfUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (/\.pdf$/i.test(u.pathname)) return true;
    if (/openreview\.net$/i.test(u.hostname.replace(/^www\./, "")) && /\/pdf/i.test(u.pathname)) return true;
    if (htmlPdfViewerHost(u.hostname)) return false;
    if (/\/pdf\/[^/]+$/i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

function isLikelyHtmlPdfLink(url) {
  try {
    const u = new URL(url);
    if (!htmlPdfViewerHost(u.hostname)) return false;
    return /\/pdf\/[^/]+$/i.test(u.pathname) && !/\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function isPdfMagic(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i <= n - 5; i++) {
    if (buf[i] === 0x25 && buf[i + 1] === 0x50 && buf[i + 2] === 0x44 && buf[i + 3] === 0x46 && buf[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

export function resolvePdfUrls(pack) {
  const pageUrl = pack?.url || "";
  const rawId = String(pack?.citationArxivId || "")
    .replace(/^arXiv:/i, "")
    .trim();
  const id = rawId || paperIdFromUrl(pageUrl);
  const out = [];
  const seen = new Set();
  const add = (u) => {
    const s = String(u || "").trim();
    if (!s) return;
    try {
      const abs = new URL(s, pageUrl || "https://example.com/").href;
      if (!/^https?:/i.test(abs)) return;
      if (isLikelyHtmlPdfLink(abs)) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push(abs);
    } catch {
      /* ignore */
    }
  };

  add(pack?.citationPdfUrl);
  for (const c of pack?.pdfCandidates || []) {
    if (id && String(c).includes(id)) add(c);
  }
  if (looksLikePdfUrl(pageUrl)) add(pageUrl);

  if (id) {
    add(`https://arxiv.org/pdf/${id}`);
    add(`https://pdfs.assets.alphaxiv.org/${id}.pdf`);
  }

  const host = (pack?.hostname || hostnameOf(pageUrl)).replace(/^www\./, "");
  if (/openreview\.net$/i.test(host) && pageUrl) {
    try {
      const fid = new URL(pageUrl).searchParams.get("id");
      if (fid) add(`https://openreview.net/pdf?id=${fid}`);
    } catch {
      /* ignore */
    }
  }
  if (/(bio|med)rxiv\.org$/i.test(host) && pageUrl && !/\.pdf$/i.test(pageUrl)) {
    add(`${pageUrl.replace(/\/$/, "")}.full.pdf`);
  }

  for (const c of pack?.pdfCandidates || []) add(c);
  return out.slice(0, 6);
}

export function shouldExtractPdf(pack) {
  const url = pack?.url || "";
  const host = pack?.hostname || hostnameOf(url);
  if (pack?.chromePdfViewer) return true;
  if (/application\/pdf/i.test(pack?.contentType || "")) return true;
  if (looksLikePdfUrl(url)) return true;
  if (pack?.citationPdfUrl || pack?.citationArxivId) return true;
  if (/arxiv\.org$/i.test(host.replace(/^www\./, "")) && /\/html\//.test(url) && (pack.text || "").length >= 3000) {
    return false;
  }
  if (isPaperHost(host, url)) return true;
  if ((pack?.text || "").length < 120 && (pack?.pdfCandidates || []).length) return true;
  return false;
}

export async function fetchPdfBytes(url, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PDF_FETCH_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > PDF_MAX_BYTES) throw new Error("PDF 太大");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > PDF_MAX_BYTES) throw new Error("PDF 太大");
    if (!isPdfMagic(buf)) throw new Error("not-pdf");
    return buf;
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("PDF 下载超时");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function itemsToText(items) {
  const lines = [];
  let line = "";
  let lastY = null;
  const flush = () => {
    const t = line.replace(/[ \t]+/g, " ").trim();
    if (t) lines.push(t);
    line = "";
  };
  for (const it of items || []) {
    if (typeof it.str !== "string") continue;
    const y = Array.isArray(it.transform) ? it.transform[5] : null;
    const jumped = lastY != null && y != null && Math.abs(y - lastY) > 3;
    if (jumped) flush();
    if (it.str) {
      if (line && !/\s$/.test(line) && !/^\s/.test(it.str)) line += " ";
      line += it.str;
    }
    if (it.hasEOL) {
      flush();
      lastY = null;
    } else if (y != null) {
      lastY = y;
    }
  }
  flush();
  return lines.join("\n");
}

function quotesFromText(text) {
  const quotes = [];
  for (const raw of String(text || "").split(/\n+/)) {
    const t = raw.replace(/^--- 第 \d+ 页 ---\s*/, "").trim();
    if (t.length < 40 || t.length > 500) continue;
    quotes.push({ id: `q_${quotes.length + 1}`, text: t.slice(0, 280) });
    if (quotes.length >= 8) break;
  }
  return quotes;
}

function pdfWorkerSrc() {
  try {
    if (globalThis.chrome?.runtime?.getURL) {
      return chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
    }
  } catch {
    /* ignore */
  }
  return new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
}

async function loadPdfjs() {
  if (!pdfjsMod) pdfjsMod = import("../vendor/pdfjs/pdf.min.mjs");
  return pdfjsMod;
}

export async function pdfBytesToText(bytes, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : PDF_MAX_CHARS;
  const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : PDF_MAX_PAGES;
  const pdfjs = await loadPdfjs();
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const data = new Uint8Array(src);
  const base = {
    data,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
    useSystemFonts: true,
  };
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc();
  const useWorker = Boolean(globalThis.chrome?.runtime?.getURL) && opts.disableWorker !== true;
  let doc;
  try {
    doc = await pdfjs.getDocument({ ...base, disableWorker: !useWorker }).promise;
  } catch (err) {
    if (!useWorker) throw err;
    doc = await pdfjs.getDocument({ ...base, disableWorker: true }).promise;
  }

  const parts = [];
  const pageCount = doc.numPages || 0;
  const used = Math.min(pageCount, maxPages);
  let truncated = pageCount > maxPages;
  for (let i = 1; i <= used; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const body = itemsToText(content.items);
    parts.push(`--- 第 ${i} 页 ---\n${body}`.trim());
    if (parts.join("\n\n").length >= maxChars) {
      truncated = true;
      break;
    }
  }
  try {
    await doc.destroy?.();
  } catch {
    /* ignore */
  }
  let text = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trim();
    truncated = true;
  }
  return {
    text,
    pages: pageCount,
    usedPages: used,
    truncated,
    quotes: quotesFromText(text),
  };
}

export async function enrichPackWithPdf(pack, opts = {}) {
  const src = pack && typeof pack === "object" ? pack : {};
  if (!shouldExtractPdf(src)) return src;
  const urls = resolvePdfUrls(src);
  if (!urls.length) return src;
  const errors = [];
  const fetchImpl = opts.fetchImpl || fetch;
  for (const url of urls) {
    try {
      const bytes = await fetchPdfBytes(url, fetchImpl);
      const extracted = await pdfBytesToText(bytes, opts);
      if (!extracted.text || extracted.text.replace(/--- 第 \d+ 页 ---/g, "").trim().length < 40) {
        errors.push(`${url}: 没有文字层`);
        continue;
      }
      return {
        ...src,
        kind: "pdf",
        text: extracted.text,
        quotes: extracted.quotes?.length ? extracted.quotes : src.quotes || [],
        pdfUrl: url,
        pdfPages: extracted.pages,
        pdfTruncated: extracted.truncated,
        pdfError: "",
        videoIsPrimary: false,
      };
    } catch (err) {
      errors.push(`${url}: ${err?.message || err}`);
    }
  }
  return errors.length ? { ...src, pdfError: errors[0] } : src;
}
