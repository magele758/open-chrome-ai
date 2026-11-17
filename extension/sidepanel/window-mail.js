import { DELEGATE_STORAGE_KEY, MAX_CONCURRENT_TASKS } from "../lib/agent/delegate.js";
import { listPeerWindows, mailKey, readWindowMail, sendWindowMail, waitForWindowResult, WORK_STATUS } from "../lib/window-mail.js";

export function windowMailTools(from, getCapsule, userMessageId) {
  const requestKey = callId => userMessageId && callId ? `${userMessageId}/${callId}` : undefined;
  async function cancelDispatched(taskId) {
    await chrome.runtime.sendMessage({ type: "pl.windowMail.cancel", from, id: taskId });
  }
  // 停止只取消这一条，任务已不是 running 时不再发送。
  async function cancelIfStillRunning(taskId) {
    const row = (await readWindowMail(from)).find(item => item.id === taskId && item.kind === "task");
    if (row && row.status !== "running") return;
    await cancelDispatched(taskId);
  }
  const empty = { type: "object", properties: {}, additionalProperties: false };
  const target = { type: "object", properties: {
    windowId: { type: "integer", description: "来自 list_task_windows 的目标窗口 ID" },
    text: { type: "string", minLength: 1, maxLength: 8000 },
  }, required: ["windowId", "text"], additionalProperties: false };
  return [
    {
      name: "run_parallel_tasks",
      description: "将一个任务拆为可独立执行的子任务后，一次提交全部分工。每项自动新开一个专用后台 Chrome 窗口并行执行，收齐回执后由你汇总。简单任务直接在本窗口完成。",
      parameters: { ...empty, properties: { tasks: {
        type: "array", minItems: 2, maxItems: MAX_CONCURRENT_TASKS,
        items: { type: "string", minLength: 1, maxLength: 8000 },
        description: "每项是给一个新窗口的完整任务，含可用来源网址、要查的问题和预期产出。工作窗口从空白页开始，只能使用自己的标签。",
      } }, required: ["tasks"] },
      async execute({ tasks }, { signal, callId } = {}) {
        if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > MAX_CONCURRENT_TASKS ||
            tasks.some(t => typeof t !== "string" || !t.trim() || t.trim().length > 8000)) {
          throw new Error(`请一次提供 2 至 ${MAX_CONCURRENT_TASKS} 项独立任务，每项最多 8000 字。`);
        }
        signal?.throwIfAborted();
        const batch = requestKey(callId) || crypto.randomUUID();
        const capsule = getCapsule() || {};
        const results = await Promise.all(tasks.map(async (text, index) => {
          try {
            const entry = await sendWindowMail(from, null, "auto_task", text, capsule, `auto/${batch}/${index}`);
            return await waitForWindowResult(from, entry.id, signal);
          } catch (err) {
            signal?.throwIfAborted();
            return { text, status: "failed", result: err.message };
          }
        }));
        return JSON.stringify(results);
      },
    },
    {
      name: "list_task_windows", description: "获取本窗口和可通信的普通窗口 ID。", parameters: empty,
      execute: async () => JSON.stringify({ current: from, peers: await listPeerWindows(from) }),
    },
    {
      name: "read_window_inbox", description: "读取近期来往消息和回执。传入本窗口派发的 taskId 时会等待该任务的结果。",
      parameters: { ...empty, properties: { taskId: { type: "string" } } },
      execute: async ({ taskId } = {}, { signal } = {}) => JSON.stringify(taskId
        ? await waitForWindowResult(from, taskId, signal) : (await readWindowMail(from)).slice(0, 20)),
    },
    {
      name: "send_window_message", description: "把一条文本直接送到目标窗口的收件箱。", parameters: target,
      execute: async ({ windowId, text }, { callId } = {}) =>
        JSON.stringify(await sendWindowMail(from, windowId, "message", text, undefined, requestKey(callId))),
    },
    {
      name: "delegate_window_task", description: "请目标窗口用自己的标签完成任务，等待并返回结果。发起窗口可直接据此回答用户。",
      parameters: { ...target, properties: { ...target.properties,
        background: { type: "boolean", description: "并发分工时设为 true，立即返回 taskId。随后可用 read_window_inbox 等待结果。" },
      } },
      async execute({ windowId, text, background }, { signal, callId } = {}) {
        signal?.throwIfAborted();
        const entry = await sendWindowMail(from, windowId, "task", text, getCapsule() || {}, requestKey(callId));
        if (signal?.aborted) {
          try { await cancelDispatched(entry.id); } catch { /* 中止优先于取消失败 */ }
          signal.throwIfAborted();
        }
        if (!background) return JSON.stringify(await waitForWindowResult(from, entry.id, signal));
        const taskId = entry.id;
        const onAbort = () => { cancelIfStillRunning(taskId).catch(() => {}); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          signal.removeEventListener("abort", onAbort);
          try { await cancelDispatched(taskId); } catch { /* 中止优先于取消失败 */ }
          signal.throwIfAborted();
        }
        return JSON.stringify({ taskId, status: entry.status });
      },
    },
  ];
}

export function bindWindowMail(windowId) {
  const box = document.getElementById("window-mail");
  const select = document.getElementById("window-peer");
  const draft = document.getElementById("window-mail-text");
  const log = document.getElementById("window-mail-log");
  const status = document.getElementById("window-mail-status");
  const summary = box.querySelector("summary");
  const title = `窗口协作 · 本窗口 ${windowId}`;
  summary.textContent = title;
  let revision = 0;
  let peerRevision = 0;
  let previous = "";
  async function refreshPeers() {
    const current = ++peerRevision;
    const peers = await listPeerWindows(windowId);
    if (current !== peerRevision) return;
    const selected = select.value;
    select.replaceChildren(new Option(peers.length ? "选择接收窗口" : "暂无其他窗口", ""));
    for (const id of peers) select.add(new Option(`窗口 ${id}`, String(id)));
    select.value = peers.includes(Number(selected)) ? selected : "";
  }
  async function render() {
    const current = ++revision;
    const entries = await readWindowMail(windowId);
    if (current !== revision) return;
    const signature = JSON.stringify(entries.map(e => [e.id, e.status]));
    if (signature === previous) return;
    previous = signature;
    const latest = entries[0];
    if (latest) {
      const returned = latest.kind === "task" && latest.status !== "running";
      const source = returned ? latest.to : latest.from;
      const peer = latest.from === windowId ? latest.to : latest.from;
      const label = latest.kind === "task" ? WORK_STATUS[latest.status] : "消息";
      summary.textContent = `${title} · ${label} · ${source === windowId ? "发往" : "来自"}窗口 ${peer}`;
    } else summary.textContent = title;
    const rows = entries.map(e => {
      const row = document.createElement("li");
      const label = document.createElement("strong");
      label.textContent = `窗口 ${e.from} → ${e.to} · ${e.kind === "task" ? WORK_STATUS[e.status] : "消息"}`;
      const body = document.createElement("div");
      body.textContent = e.text;
      row.append(label, body);
      if (e.result) {
        const result = document.createElement("p");
        result.textContent = `窗口 ${e.to} 回执 · ${e.result}`;
        row.append(result);
      }
      return row;
    });
    log.replaceChildren(...rows);
  }
  const report = err => { status.textContent = err.message; };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && (changes[mailKey(windowId)] || changes[DELEGATE_STORAGE_KEY])) render().catch(report);
  });
  box.addEventListener("toggle", () => { if (box.open) refreshPeers().catch(report); });
  chrome.windows.onCreated.addListener(() => refreshPeers().catch(report));
  chrome.windows.onRemoved.addListener(() => refreshPeers().catch(report));
  let sending = false;
  for (const button of box.querySelectorAll("button[data-kind]")) {
    button.addEventListener("click", async () => {
      if (sending) return;
      if (!select.value || !draft.value.trim()) {
        status.textContent = "请选择接收窗口并填写内容。";
        return;
      }
      const text = draft.value;
      sending = true;
      try {
        await sendWindowMail(windowId, Number(select.value), button.dataset.kind, text);
        if (draft.value === text) draft.value = "";
        status.textContent = button.dataset.kind === "task" ? "任务已派发，结果将在此显示。" : "消息已送达。";
      } catch (err) { report(err); }
      finally { sending = false; }
    });
  }
  render().catch(report);
  refreshPeers().catch(report);
}
