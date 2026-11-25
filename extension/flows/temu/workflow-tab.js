const TAB_TIMEOUT = 16000;

export function waitForTemu(signal, ms) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export async function openTemuWorkflowTab({ tab, href, accepts, signal, tabs = chrome.tabs }) {
  signal?.throwIfAborted();
  if (!accepts(href)) throw new Error("Temu 工作流地址无效。");
  const matches = candidate => accepts(candidate?.url) && (!candidate.pendingUrl || accepts(candidate.pendingUrl));
  const reuse = Number.isInteger(tab?.id) && tab.active && matches(tab);
  const target = reuse ? tab : await tabs.create({
    url: href, active: true, ...(Number.isInteger(tab?.windowId) ? { windowId: tab.windowId } : {}),
  });
  if (!Number.isInteger(target?.id)) throw new Error("无法打开 Temu 标签页。");
  const deadline = Date.now() + TAB_TIMEOUT;
  do {
    signal?.throwIfAborted();
    const current = await tabs.get(target.id).catch(() => null);
    signal?.throwIfAborted();
    if (current?.id !== target.id || !current.active) throw new Error("Temu 标签已关闭或切换，请重试。");
    if (current.status !== "loading") {
      if (matches(current)) return current;
      if (current.url && /^https?:/iu.test(current.url) && !current.pendingUrl) {
        throw new Error("Temu 页面已跳转，请检查登录状态或页面访问权限后重试。");
      }
    }
    await waitForTemu(signal, 200);
  } while (Date.now() < deadline);
  throw new Error("Temu 页面加载超时，请检查登录状态或页面访问权限后重试。");
}
