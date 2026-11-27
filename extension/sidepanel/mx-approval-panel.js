const waitReason = {
  no_page: "等待打开墨西哥商品管理 → 全部",
  stale_page: "当前列表早于本次提审，可手动刷新列表",
  unreadable: "已打开的商品列表暂时无法读取",
  access_disabled: "请启用外部 Agent 控制并允许访问卖家站点",
  read_error: "上次读取失败，等待重试",
  not_found: "当前列表未找到商品",
  unrecognized: "当前列表未显示可识别的审核状态",
  under_review: "商品审核中",
  optimization_under_review: "标题审核中",
  notification_failed: "审核结果已确认，等待重试通知",
  attention: "商品需要处理",
  active: "列表显示在售",
  inactive: "列表显示已下架",
  rejected: "列表显示审核未通过",
  deleted: "列表显示商品已删除",
};

const finishedReason = {
  approved: "已通过审核",
  cancelled: "已手动停止",
  disabled: "已关闭跟踪",
  expired: "跟踪已到期",
  not_found: "已停止 · 当前列表未找到商品",
  rejected: "已停止 · 审核未通过",
  deleted: "已停止 · 商品已删除",
  inactive: "已停止 · 商品已下架",
  superseded: "已由新提交的审核替代",
};

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function bindMxApprovalPanel(root, api = chrome) {
  const get = id => root.querySelector("#mx-approval-" + id);
  const toggle = get("enabled");
  const document = root.ownerDocument;
  const settings = root.closest("#view-settings");
  const tab = root.closest('[role="tabpanel"]');
  const visible = () => !tab.hidden && !settings.classList.contains("hidden");
  let state;
  let reading = false;
  let busy = false;
  let revision = 0;

  function renderList(list, watches) {
    list.replaceChildren();
    for (const watch of watches) {
      const watching = watch.state === "watching";
      const li = document.createElement("li");
      const info = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = watch.title || watch.productId;
      const detail = document.createElement("small");
      const kind = watch.mode === "optimize_listing" ? "标题审核" : "商品上架";
      let reason = finishedReason[watch.state] || "已结束";
      if (watching) {
        reason = waitReason[watch.lastStatus] || "等待检查";
        if (watch.mode === "optimize_listing" && ["active", "inactive"].includes(watch.lastStatus))
          reason += "，等待新标题生效";
      }
      detail.textContent = [watch.title && watch.productId, kind, reason].filter(Boolean).join(" · ");
      info.append(heading, detail);
      const timestamps = [];
      for (const [label, value] of [["最近检查", watch.lastCheckedAt],
        watching ? ["截止", watch.expiresAt] : ["结束", watch.finishedAt]]) {
        if (Number.isFinite(value)) timestamps.push(label + " " + dateFormat.format(value));
      }
      if (timestamps.length) {
        const time = document.createElement("small");
        time.textContent = timestamps.join(" · ");
        info.append(time);
      }
      li.append(info);
      if (watching) {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "compact secondary";
        stop.textContent = "停止";
        stop.setAttribute("aria-label", "停止跟踪 " + watch.productId + " 的" + kind);
        stop.disabled = busy;
        stop.addEventListener("click", () => update({ type: "pl.mxApproval.cancel", key: watch.key }));
        li.append(stop);
      }
      list.append(li);
    }
  }

  function render() {
    if (!visible()) return;
    toggle.disabled = busy || !state;
    if (!state) return;
    const pending = state.watches.filter(w => w.state === "watching");
    const summary = state.enabled
      ? pending.length ? pending.length + " 条跟踪中" : "已开启"
      : "已关闭";
    if (get("summary").textContent !== summary) get("summary").textContent = summary;
    if (!root.open) return;
    toggle.checked = state.enabled;
    const finished = state.watches.filter(w => w.state !== "watching")
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    get("empty").hidden = pending.length > 0;
    get("history").hidden = !finished.length;
    get("history-label").textContent = "已结束的跟踪（" + finished.length + "）";
    renderList(get("pending"), pending);
    renderList(get("finished"), finished);
  }

  async function request(message) {
    const latest = ++revision;
    try {
      const reply = await api.runtime.sendMessage(message);
      if (latest !== revision) return;
      if (!reply?.ok || !Array.isArray(reply.state?.watches))
        throw Error(reply?.error || "无法读取审核跟踪");
      state = reply.state;
      get("error").textContent = "";
    } catch (error) {
      if (latest !== revision) return;
      get("error").textContent = error.message || String(error);
      if (!state) get("summary").textContent = "读取失败";
    }
    render();
  }

  async function update(message) {
    if (busy || !state) return;
    busy = true;
    get("error").textContent = "";
    render();
    try { await request(message); }
    finally { busy = false; render(); }
  }

  async function refreshView() {
    if (!visible()) return;
    if (state || reading) return render();
    reading = true;
    try { await request({ type: "pl.mxApproval.get" }); }
    finally { reading = false; }
  }

  toggle.addEventListener("change", () => update({ type: "pl.mxApproval.setEnabled", enabled: toggle.checked }));
  root.addEventListener("toggle", refreshView);
  const observer = new document.defaultView.MutationObserver(refreshView);
  observer.observe(tab, { attributes: true, attributeFilter: ["hidden"] });
  observer.observe(settings, { attributes: true, attributeFilter: ["class"] });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.agentMxApprovalWatch) return;
    const next = changes.agentMxApprovalWatch.newValue;
    revision++;
    if (typeof next?.enabled === "boolean" && Array.isArray(next.watches)) {
      state = next;
      render();
    } else {
      // A storage reset or legacy import needs a fresh, normalized view.
      state = null;
      reading = false;
      refreshView();
    }
  });
  refreshView();
}
