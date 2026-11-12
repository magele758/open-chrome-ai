import { archiveKeys } from "./audio-composer.js";
import { idbDel, idbSet, idbValuesWithPrefix } from "./idb-kv.js";

const prefix = "dub-queue:";
export async function loadDubJobs() {
  return (await idbValuesWithPrefix(prefix)).sort((a, b) => a.added - b.added);
}
export async function saveDubJob(row) {
  if (!await idbSet(prefix + row.id, row)) throw Error("预处理队列保存失败，请检查浏览器存储空间");
}
export const unfinished = row => ["queued", "running"].includes(row.status);

export function unifiedDubList(jobs, archives, live) {
  const merged = new Map();
  for (const row of live) if (!merged.has(row.id)) merged.set(row.id, row);
  const ready = new Map(archives.map(row => [row.id, row]));
  for (const job of jobs) {
    if (merged.has(job.id)) continue;
    const archive = ready.get(job.id);
    const stale = job.status === "ready" && !archive;
    merged.set(job.id, !unfinished(job) && archive ? archive : { ...job, status: stale ? "expired" : job.status });
  }
  for (const row of archives) if (!merged.has(row.id)) merged.set(row.id, row);
  return [...merged.values()];
}

export class DubQueue {
  constructor({ load = loadDubJobs, save = saveDubJob, process }) {
    this.save = save;
    this.process = process;
    this.rows = new Map();
    this.writes = load().then(rows => {
      for (const row of rows) {
        if (unfinished(row)) row.status = "queued";
        this.rows.set(row.id, row);
      }
    });
  }

  enqueue(input) {
    const write = this.writes.then(async () => {
      if (unfinished(this.rows.get(input.id) || {})) return;
      const row = { ...input, media: input.media ?? this.rows.get(input.id)?.media, added: Date.now(), status: "queued", detail: "" };
      await this.save(row);
      this.rows.delete(row.id);
      this.rows.set(row.id, row);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  remove(id) {
    const write = this.writes.then(async () => {
      if (unfinished(this.rows.get(id) || {})) throw Error("任务仍在处理中");
      if (!await idbDel([prefix + id, ...archiveKeys(id)])) throw Error("删除配音失败");
      this.rows.delete(id);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  setForeground(active) {
    this.foreground = active;
    if (active) this.background?.abort();
  }

  async list() {
    await this.writes;
    return [...this.rows.values()].map(({ media, ...row }) => row);
  }

  async drain() {
    await this.writes;
    if (this.worker) return this.worker;
    this.worker = this.run().finally(() => { this.worker = null; });
    return this.worker;
  }

  async run() {
    for (;;) {
      await this.writes;
      const row = [...this.rows.values()].find(r => r.status === "queued");
      if (!row || this.foreground) return;
      const background = new AbortController();
      this.background = background;
      row.status = "running";
      row.detail = "正在准备音轨";
      try {
        await this.save(row);
        background.signal.throwIfAborted();
        const expiry = await this.process(row, detail => { row.detail = detail; }, background.signal);
        background.signal.throwIfAborted();
        if (!expiry) throw Error("未生成完整音频，可重试补全");
        row.expireAt = expiry;
        row.status = "ready";
        row.detail = "";
      } catch (error) {
        row.status = background.signal.aborted ? "queued" : "failed";
        row.detail = background.signal.aborted ? "等待实时同传结束后继续" : error.message || String(error);
      } finally {
        this.background = null;
      }
      await this.save(row);
    }
  }
}
