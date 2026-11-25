export function isMxSellerManageReturn(value) {
  if (typeof value !== "string" || !value) return false;
  let page;
  try { page = new URL(value); } catch { return false; }
  const tab = page.searchParams.get("tab");
  return page.origin === "https://seller.tiktokshopglobalselling.com" && !page.username && !page.password &&
    page.searchParams.get("shop_region") === "MX" &&
    ((page.pathname === "/product/manage" && (tab === null || tab === "draft")) ||
      page.pathname === "/product/listing");
}

export function normDraftTitle(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}
export function draftTitleOf(text) {
  const idToken = /(?:草稿|draft|商品|产品|SKU|product|shop|店铺)?\s*ID\s*[:：]\s*\d+/gi;
  // A wrapped title is every remaining line. Price sits in its own column.
  const lines = String(text ?? "")
    .split(/\n/)
    .map((line) => line.replace(idToken, "").trim())
    .filter((line) => line && !/^MX\$\s*[\d.,]+$/i.test(line));
  return normDraftTitle(lines.join(" "));
}
export function draftIdOf(text) {
  const source = String(text ?? "");
  const explicit = [...source.matchAll(/(?:草稿|draft)\s*ID\s*[:：]\s*(\d+)/gi)];
  if (explicit.length > 1) return null;
  if (explicit.length === 1) return explicit[0][1];
  if (/(?:商品|产品|SKU|product|shop|店铺)\s*ID\s*[:：]\s*\d+/i.test(source)) return null;
  const ids = [...source.matchAll(/(^|[^\p{L}\p{N}_])ID\s*[:：]\s*(\d+)/giu)].map((match) => match[2]);
  return ids.length === 1 ? ids[0] : null;
}
export function selectDraftRows(records, title, draftId = null) {
  const want = normDraftTitle(title);
  const matches = [];
  for (const record of records) {
    const text = String(record.text ?? "");
    const titleText = record.title != null && String(record.title).trim()
      ? draftTitleOf(record.title)
      : draftTitleOf(text);
    const id = record.id ?? draftIdOf(text);
    if (draftId != null && draftId !== "") {
      if (id != null && String(id) === String(draftId))
        matches.push({ text: text.slice(0, 450), id: String(id) });
      continue;
    }
    if (titleText !== want) continue;
    matches.push({ text: text.slice(0, 450), id: id || undefined });
  }
  return matches;
}
export function draftListReady(text, rowCount) {
  if (/暂无商品/.test(String(text || ""))) return true;
  return rowCount > 0;
}
// Only inspect visible seller UI. A challenge frame's contents are not needed.
export function sellerVerification() {
  const visible = el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  for (const frame of document.querySelectorAll("iframe")) {
    if (visible(frame) && /captcha|verifycenter|challenge-platform/.test(frame.src.toLowerCase()))
      return "verification frame";
  }
  const prompt = /拖动完成上方拼图|请完成下列验证|verify to continue|drag the slider|desliza.{0,40}rompecabezas|completa la verificaci[oó]n/i;
  if (prompt.test(document.body?.innerText || "")) return "verification prompt";
  return "";
}
async function readDraftList(title, draftId, waitForMatch) {
  const started = Date.now();
  let previous = null;
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    const verification = sellerVerification();
    if (verification) throw Error("Seller verification on draft list: " + verification);
    const text = document.body?.innerText || "";
    const empty = text.includes("暂无商品") && text.includes("你正在编辑的发品草稿会显示在此处");
    const records = [...document.querySelectorAll("tbody tr, [role=row]")].filter(row =>
      row.getClientRects().length && [...row.querySelectorAll("td,[role=cell]")].some(cell =>
        /^(草稿|draft|borrador)(?:\s|$)/i.test(cell.innerText.trim()))).map((row) => {
      // The generic overflow component is also used by the “草稿” status badge.
      // The product cell contains the standalone draft ID and its adjacent title.
      const cell = [...row.querySelectorAll("td,[role=cell]")].find(c => draftIdOf(c.innerText));
      const raw = cell?.innerText || row.innerText || "";
      return { title: raw, text: row.innerText || "" };
    }).filter(row => draftIdOf(row.text));
    const ready = location.search.includes("tab=draft") && (empty || records.length > 0);
    const signature = records.length ? records.map(row => row.text).join("\u0000") : "empty";
    if (ready && signature === previous) stable += 1;
    else stable = 0;
    previous = signature;
    if (ready && stable >= 1) {
      const matches = selectDraftRows(records, title, draftId);
      if (!waitForMatch || matches.length || Date.now() - started >= 2000)
        return { matches, ids: records.map(row => draftIdOf(row.text)) };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Draft list not ready or seller login required");
}
export function draftListCode(title, draftId = null, waitForMatch = false) {
  const code = [
    normDraftTitle,
    draftTitleOf,
    draftIdOf,
    selectDraftRows,
    draftListReady,
    sellerVerification,
    readDraftList,
  ].map((fn) => fn.toString()).join("\n");
  return code + "\nreturn await readDraftList(" + JSON.stringify(title) + "," + JSON.stringify(draftId) + "," + Boolean(waitForMatch) + ")";
}
