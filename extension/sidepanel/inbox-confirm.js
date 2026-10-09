const ACTION_LABELS = {
  paste_html: "往页面粘贴富文本",
  wechat_fill_draft: "填写微信公众号草稿（不点发表）",
  cose_publish: "通过 COSE 发布文章",
};

const id = new URLSearchParams(location.search).get("id") || "";
const $ = (sel) => document.getElementById(sel);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, id, ...extra });

function showGone() {
  $("body").classList.add("hidden");
  $("gone").classList.remove("hidden");
  $("btn-approve").disabled = true;
  $("btn-reject").disabled = true;
  $("timer").textContent = "";
}

async function answer(approved) {
  $("btn-approve").disabled = true;
  $("btn-reject").disabled = true;
  await send("pl.inboxConfirm.answer", { approved }).catch(() => {});
  window.close();
}

async function main() {
  const res = await send("pl.inboxConfirm.get").catch(() => null);
  if (!res?.ok) return showGone();
  const s = res.summary || {};
  $("f-action").textContent = `${ACTION_LABELS[s.action] || s.action}（${s.action}）`;
  $("f-origin").textContent = s.origin || "(未知)";
  $("f-tab").textContent = s.tabTitle || "";
  $("f-title").textContent = s.title || "(无)";
  $("f-platforms").textContent = s.platforms?.length ? s.platforms.join(", ") : "—";
  $("f-chars").textContent = `${s.chars || 0} 字`;
  $("f-job").textContent = s.jobId || "—";
  $("f-preview").textContent = s.preview || "(无预览)";
  $("btn-approve").addEventListener("click", () => answer(true));
  $("btn-reject").addEventListener("click", () => answer(false));

  const deadline = Date.now() + (res.remainingMs || 0);
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    $("timer").textContent = `${left}s 后自动拒绝`;
  };
  tick();
  setInterval(tick, 1000);
  setInterval(async () => {
    const ping = await send("pl.inboxConfirm.ping").catch(() => null);
    if (!ping?.ok) showGone();
  }, 5000);
}

main();
