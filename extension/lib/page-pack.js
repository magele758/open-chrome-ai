import { extractPage } from "./extract.js";
import { inject, restrictedUrl } from "./chrome.js";
import { enrichPackWithPdf, hostnameOf } from "./pdf-text.js";

function emptyPack(tab) {
  return {
    title: tab?.title || "",
    url: tab?.url || "",
    hostname: hostnameOf(tab?.url || ""),
    text: "",
    quotes: [],
    kind: "generic",
    video: null,
  };
}

export async function loadTabPack(tabId) {
  if (!tabId) throw new Error("没有可操作的标签");
  const tab = await chrome.tabs.get(tabId);
  if (restrictedUrl(tab?.url)) {
    return emptyPack(tab);
  }
  let pack;
  try {
    pack = await inject(tabId, extractPage);
  } catch {
    pack = null;
  }
  pack = pack && typeof pack === "object" ? { ...pack } : emptyPack(tab);
  pack.title = pack.title || tab.title || "";
  pack.url = pack.url || tab.url || "";
  pack.hostname = pack.hostname || hostnameOf(pack.url);
  pack.text = pack.text || "";
  pack.quotes = Array.isArray(pack.quotes) ? pack.quotes : [];
  pack.kind = pack.kind || "generic";
  try {
    pack = await enrichPackWithPdf(pack);
  } catch (err) {
    pack.pdfError = err?.message || String(err);
  }
  return pack;
}
