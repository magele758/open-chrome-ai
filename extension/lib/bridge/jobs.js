/**
 * async 任务表：内存 + chrome.storage.session 持久化（SW 被回收后 job_status 仍查得到）。
 * 恢复时仍是 running 的任务标成 interrupted：SW 重启打断了它，结果未知。
 * 持久化副本里大的 artifact 只留元数据（storage.session 总配额 10 MB）。
 */

export const JOBS_KEY = "agentBridgeJobs";
export const JOB_MAX = 50;
export const PERSIST_ARTIFACT_MAX = 256 * 1024;

function slimResponse(response) {
  if (!response?.artifacts?.length) return response;
  return {
    ...response,
    artifacts: response.artifacts.map((a) =>
      String(a.data || "").length > PERSIST_ARTIFACT_MAX
        ? { name: a.name, mime: a.mime, encoding: a.encoding, size: a.size, data: "", omitted: true }
        : a,
    ),
  };
}

/** @param storage { get(key) → {key: value}, set(obj) }，缺省时只在内存里。 */
export function createJobStore({ storage = null, now = () => Date.now(), max = JOB_MAX } = {}) {
  const jobs = new Map();
  let writing = Promise.resolve();

  const ready = (async () => {
    if (!storage) return;
    try {
      const saved = (await storage.get(JOBS_KEY))?.[JOBS_KEY];
      let changed = false;
      for (const [key, job] of Array.isArray(saved) ? saved : []) {
        if (!job || jobs.has(key)) continue;
        if (job.status === "running") {
          job.status = "interrupted";
          job.interruptedAt = now();
          changed = true;
        }
        jobs.set(key, job);
      }
      if (changed) persist();
    } catch {
      /* storage.session 不可用：退回纯内存 */
    }
  })();

  function trim() {
    while (jobs.size > max) jobs.delete(jobs.keys().next().value);
  }

  function persist() {
    if (!storage) return writing;
    writing = writing
      .then(() => ready)
      .then(() => {
        const snapshot = [...jobs].map(([k, j]) => [k, j.response ? { ...j, response: slimResponse(j.response) } : j]);
        return storage.set({ [JOBS_KEY]: snapshot });
      })
      .catch(() => {});
    return writing;
  }

  return {
    ready,
    start(key, { tool, sessionId = null, agentId = null } = {}) {
      jobs.delete(key);
      jobs.set(key, { status: "running", tool, sessionId, agentId, startedAt: now(), response: null });
      trim();
      persist();
    },
    finish(key, response) {
      const job = jobs.get(key);
      if (!job) return;
      Object.assign(job, { status: "done", finishedAt: now(), response });
      persist();
    },
    async get(key) {
      await ready;
      return jobs.get(key) || null;
    },
    flush: () => persist(),
    size: () => jobs.size,
  };
}

export function chromeSessionStorage(api = globalThis.chrome) {
  const area = api?.storage?.session;
  if (!area?.get || !area?.set) return null;
  return { get: (key) => area.get(key), set: (obj) => area.set(obj) };
}
