import {
  paperIdFromUrl,
  looksLikePdfUrl,
  isPaperHost,
  isPdfMagic,
  resolvePdfUrls,
  shouldExtractPdf,
  fetchPdfBytes,
  pdfBytesToText,
  enrichPackWithPdf,
} from "../lib/pdf-text.js";
import { packToContext } from "../lib/prompts.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function makePdf(text) {
  const escaped = String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\n`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(body);
  body += `xref\n0 ${objs.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body));
}

function okPdfResponse(bytes) {
  const buf = bytes;
  return {
    ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? String(buf.byteLength) : "application/pdf") },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function htmlResponse() {
  const buf = new TextEncoder().encode("<!doctype html><title>viewer</title>");
  return {
    ok: true,
    headers: { get: () => "text/html" },
    arrayBuffer: async () => buf.buffer,
  };
}

assert(paperIdFromUrl("https://www.alphaxiv.org/abs/2512.24601") === "2512.24601", "alphaxiv abs id");
assert(paperIdFromUrl("https://www.alphaxiv.org/pdf/2512.24601") === "2512.24601", "alphaxiv pdf id");
assert(paperIdFromUrl("https://arxiv.org/pdf/2512.24601v3") === "2512.24601", "arxiv versioned id");
assert(paperIdFromUrl("https://arxiv.org/abs/hep-th/9901001") === "hep-th/9901001", "old arxiv id");

assert(looksLikePdfUrl("https://arxiv.org/pdf/2512.24601"), "arxiv /pdf/ is a file");
assert(looksLikePdfUrl("https://example.com/paper.pdf"), "dot pdf");
assert(!looksLikePdfUrl("https://www.alphaxiv.org/pdf/2512.24601"), "alphaxiv /pdf/ is HTML");
assert(!looksLikePdfUrl("https://www.alphaxiv.org/abs/2512.24601"), "alphaxiv abs not pdf url");

assert(isPaperHost("www.alphaxiv.org", "https://www.alphaxiv.org/abs/2512.24601"), "alphaxiv host");
assert(isPaperHost("arxiv.org", "https://arxiv.org/abs/2512.24601"), "arxiv host");
assert(!isPaperHost("a.example", "https://a.example/post"), "generic host");

const alphaAbs = {
  title: "Recursive Language Models",
  url: "https://www.alphaxiv.org/abs/2512.24601",
  hostname: "www.alphaxiv.org",
  text: "页面只提供划词高亮",
  kind: "generic",
  citationPdfUrl: "https://pdfs.assets.alphaxiv.org/2512.24601v3.pdf",
  citationArxivId: "2512.24601",
  pdfCandidates: ["https://www.alphaxiv.org/pdf/2512.24601"],
};
const urls = resolvePdfUrls(alphaAbs);
assert(urls[0] === "https://pdfs.assets.alphaxiv.org/2512.24601v3.pdf", "citation first: " + urls[0]);
assert(urls.includes("https://arxiv.org/pdf/2512.24601"), "arxiv fallback");
assert(!urls.includes("https://www.alphaxiv.org/pdf/2512.24601"), "skip alphaxiv html pdf route");

assert(shouldExtractPdf(alphaAbs), "alphaxiv should fetch pdf");
assert(shouldExtractPdf({ url: "https://arxiv.org/pdf/2512.24601", hostname: "arxiv.org", text: "" }), "direct arxiv pdf");
assert(
  !shouldExtractPdf({
    url: "https://a.example/post",
    hostname: "a.example",
    text: "这是一篇普通博文的正文，讲的是产品发布和定价。" + "段落".repeat(80),
    pdfCandidates: ["https://a.example/static/manual.pdf"],
  }),
  "generic article with a pdf link",
);
assert(
  !shouldExtractPdf({
    url: "https://arxiv.org/html/2512.24601",
    hostname: "arxiv.org",
    text: "x".repeat(4000),
  }),
  "arxiv html already has body",
);

const fixture = makePdf("Hello PageLens Recursive Language Models inference-time paradigm");
assert(isPdfMagic(fixture), "fixture magic");
assert(!isPdfMagic(new TextEncoder().encode("<!doctype html>")), "html not pdf");

const extracted = await pdfBytesToText(fixture, { disableWorker: true });
assert(/Hello PageLens/.test(extracted.text), "pdf text: " + extracted.text);
assert(extracted.pages === 1, "one page");
assert(/第 1 页/.test(extracted.text), "page marker");

const htmlBytes = new Uint8Array(new TextEncoder().encode("<html>nope</html>"));
let threw = false;
try {
  await fetchPdfBytes("https://www.alphaxiv.org/pdf/2512.24601", async () => ({
    ok: true,
    headers: { get: () => "text/html" },
    arrayBuffer: async () => htmlBytes.buffer,
  }));
} catch (err) {
  threw = /not-pdf/.test(err.message);
}
assert(threw, "html fetch rejected");

const hits = [];
const enriched = await enrichPackWithPdf(alphaAbs, {
  disableWorker: true,
  fetchImpl: async (url) => {
    hits.push(url);
    if (url.includes("pdfs.assets.alphaxiv.org")) return okPdfResponse(fixture);
    return htmlResponse();
  },
});
assert(enriched.kind === "pdf", "kind pdf");
assert(/Hello PageLens/.test(enriched.text), "enriched text");
assert(hits[0] === alphaAbs.citationPdfUrl, "fetch citation first");
assert(enriched.pdfUrl === alphaAbs.citationPdfUrl, "store pdf url");

const fallbackHits = [];
const fallback = await enrichPackWithPdf(
  {
    url: "https://www.alphaxiv.org/abs/2512.24601",
    hostname: "www.alphaxiv.org",
    text: "短",
    kind: "generic",
    citationArxivId: "2512.24601",
  },
  {
    disableWorker: true,
    fetchImpl: async (url) => {
      fallbackHits.push(url);
      if (url === "https://arxiv.org/pdf/2512.24601") return okPdfResponse(fixture);
      return htmlResponse();
    },
  },
);
assert(fallback.kind === "pdf", "fallback pdf");
assert(fallbackHits.includes("https://arxiv.org/pdf/2512.24601"), "tried arxiv");

const ctx = packToContext(enriched);
assert(/【PDF 正文】/.test(ctx), "context label");
assert(/Hello PageLens/.test(ctx), "context has pdf text");

const errCtx = packToContext({ title: "X", url: "https://www.alphaxiv.org/abs/1", pdfError: "PDF HTTP 404" });
assert(/未能抽取/.test(errCtx), "pdf error in context");

console.log("ok pdf");
