import { nativeSend } from "../native-host.js";
import { getDelegateManager, TASK_STATUS } from "./delegate.js";

const DESCRIPTOR = "local-development.json";
// The inbox agent keeps its current run in this session storage entry.
const ACTIVE_PROMPT_KEY = "agentPromptActive";
const UPDATE_KEY = "agentInboxDevelopmentUpdate";
const LOADED_REVISION_KEY = "agentInboxDevelopmentRevision";
const REQUEST_LIFETIME_MS = 90_000;
const UPDATE_CONFIRM_LIFETIME_MS = 120_000;
const bootId = crypto.randomUUID();

function isRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

async function readDescriptor() {
  if ((await chrome.management?.getSelf?.())?.installType !== "development" ||
      typeof chrome.runtime?.reload !== "function") {
    throw Error("Development updates only support unpacked extensions");
  }
  let descriptor;
  try {
    const response = await fetch(chrome.runtime.getURL(DESCRIPTOR), { cache: "no-store" });
    if (response.ok) descriptor = await response.json();
  } catch {
    // The local descriptor is optional. Treat unreadable or invalid data as disabled.
  }
  if (descriptor?.enabled !== true || descriptor.extensionId !== chrome.runtime.id || !isRevision(descriptor.revision)) {
    throw Error("Development updates have not been enabled for this extension");
  }
  return descriptor;
}

async function readUpdate() {
  const data = await chrome.storage.local.get(UPDATE_KEY);
  return data?.[UPDATE_KEY];
}

async function busy(queued) {
  if (queued || (await chrome.storage.session.get(ACTIVE_PROMPT_KEY))?.[ACTIVE_PROMPT_KEY]) return true;
  const locks = await navigator.locks.query();
  if ([...locks.held, ...locks.pending].some(lock => lock.name.startsWith("pagelens-agent-window-"))) return true;
  const tasks = await getDelegateManager()?.list() || [];
  return tasks.some(task => [TASK_STATUS.RUNNING, TASK_STATUS.NEEDS_APPROVAL].includes(task.status));
}

export async function developmentInboxJob(job, { directed, queued }) {
  if (!directed || job.token != null) throw Error("Development updates require a direct local inbox request");
  const { revision } = await readDescriptor();
  const loaded = (await chrome.storage.local.get(LOADED_REVISION_KEY))?.[LOADED_REVISION_KEY];
  if (!isRevision(loaded)) throw Error("Chrome has not loaded a prepared development build yet");
  const isBusy = await busy(queued);
  if (job.action === "dev_status") {
    const update = await readUpdate();
    const host = await nativeSend({ op: "ping" }, { interactive: false });
    if (!host.ok || !host.version || !host.repoRoot) throw Error(host.error || "Native Host is not ready");
    const lastReload = update?.stage === "completed" && update.revision === loaded
      ? { id: update.id, revision: update.revision, previousBootId: update.previousBootId }
      : null;
    return { revision: loaded, bootId, version: chrome.runtime.getManifest().version,
      host: { version: host.version, repoRoot: host.repoRoot }, busy: isBusy, lastReload };
  }

  const createdAt = Date.parse(job.createdAt);
  if (!Number.isFinite(createdAt) || createdAt > Date.now() || Date.now() - createdAt > REQUEST_LIFETIME_MS) {
    throw Error("Development update request is expired");
  }
  if (isBusy) throw Object.assign(Error("PageLens has a task in progress"), { code: "DEVELOPMENT_BUSY" });
  if (job.expectedRevision !== revision) throw Error("Development update revision does not match the prepared checkout");
  const pending = await readUpdate();
  if (pending?.stage === "pending" && Date.now() - pending.requestedAt < UPDATE_CONFIRM_LIFETIME_MS) {
    throw Error("A development update request is already pending");
  }
  await chrome.storage.local.set({ [UPDATE_KEY]: { stage: "pending", id: job.id, revision,
    previousBootId: bootId, requestedAt: Date.now() } });
  return { accepted: true, revision, bootId };
}

export async function confirmDevelopmentUpdate(details) {
  if (!["install", "update"].includes(details?.reason)) return;
  const { revision } = await readDescriptor();
  const pending = await readUpdate();
  if (pending?.stage === "pending" && pending.previousBootId === bootId) return;
  const loaded = { [LOADED_REVISION_KEY]: revision };
  if (details.reason === "update" && pending?.stage === "pending" && pending.revision === revision &&
      Date.now() - pending.requestedAt <= UPDATE_CONFIRM_LIFETIME_MS) {
    loaded[UPDATE_KEY] = { ...pending, stage: "completed" };
  }
  await chrome.storage.local.set(loaded);
}
