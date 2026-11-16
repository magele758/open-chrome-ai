import { archiveKeys } from "./audio-composer.js";
import { idbDel, idbSet, idbSetAll, idbValuesWithPrefix } from "./idb-kv.js";
import { notifySyncChange } from "./interpret-sync.js";

const prefix = "dub-queue:";
const order = row => row.order ?? row.added ?? 0;
export const canMoveDubJob = row => ["running", "queued", "paused"].includes(row.status);
export async function loadDubJobs() {
  return (await idbValuesWithPrefix(prefix)).sort((a, b) => order(a) - order(b));
}
export async function saveDubJob(row) {
  const saved = { ...row, updatedAt: Date.now() };
  if (!await idbSet(prefix + saved.id, saved)) throw Error("预处理队列保存失败，请检查浏览器存储空间");
  notifySyncChange({ kind: "idb", key: prefix + saved.id });
}
export const unfinished = row => ["queued", "running"].includes(row.status);

export function unifiedDubList(jobs, archives, live) {
  const merged = new Map();
  const playing = new Set(live.map(row => row.id));
  const ready = new Map(archives.map(row => [row.id, row]));
  for (const job of jobs) {
    const archive = ready.get(job.id);
    const stale = job.status === "ready" && !archive;
    const row = job.status === "ready" && archive ? { ...job, ...archive } : { ...job, status: stale ? "expired" : job.status };
    merged.set(job.id, playing.has(job.id) ? { ...row, live: true } : row);
  }
  for (const row of live) if (!merged.has(row.id)) merged.set(row.id, ready.has(row.id) ? { ...ready.get(row.id), live: true } : row);
  for (const row of archives) if (!merged.has(row.id)) merged.set(row.id, row);
  const group = row => row.status === "live" ? 0 : canMoveDubJob(row) ? 1 : 2;
  return [...merged.values()].sort((a, b) => group(a) - group(b) || (canMoveDubJob(a) && canMoveDubJob(b) ? order(a) - order(b) : 0));
}

export class DubQueue {
  constructor({ load = loadDubJobs, save = saveDubJob, process }) {
    this.save = save;
    this.process = process;
    this.rows = new Map();
    this.live = new Set();
    this.writes = load().then(rows => {
      for (const row of rows) {
        if (unfinished(row)) { row.status = "queued"; row.detail = ""; }
        this.rows.set(row.id, row);
      }
    });
  }

  update(action) {
    const write = this.writes.then(action);
    this.writes = write.catch(() => {});
    return write;
  }

  enqueue(input) {
    return this.update(async () => {
      const previous = this.rows.get(input.id);
      if (previous && (unfinished(previous) || previous.status === "paused")) return;
      const added = Date.now();
      const lastOrder = [...this.rows.values()].reduce((last, row) => Math.max(last, order(row)), 0);
      const ownerId = typeof chrome !== "undefined" ? chrome.runtime?.id || "" : "";
      const row = { ...input, media: input.media ?? previous?.media, poster: input.poster || previous?.poster,
        ownerId, added, order: Math.max(added, lastOrder + 1), status: "queued", detail: "" };
      await this.save(row);
      this.rows.delete(row.id);
      this.rows.set(row.id, row);
    });
  }

  claimLive(id) {
    return this.update(async () => {
      if (this.live.has(id)) throw Error("这个视频已经在实时同传中");
      this.live.add(id);
      try { await this.stopBackground(id); }
      catch (err) { this.live.delete(id); throw err; }
    });
  }

  async stopBackground(id) {
    if (this.background?.id === id) {
      this.background.controller.abort();
      await this.background.done;
    }
  }

  setPaused(id, paused) {
    return this.update(async () => {
      const row = this.rows.get(id);
      if (!row || (paused ? !unfinished(row) : row.status !== "paused")) return;
      if (paused) await this.stopBackground(id);
      const ownerId = paused ? row.ownerId || "" : (typeof chrome !== "undefined" ? chrome.runtime?.id || row.ownerId || "" : "");
      const next = { ...row, ownerId, status: paused ? "paused" : "queued", detail: "" };
      await this.save(next);
      this.rows.set(id, next);
    });
  }

  move(id, direction) {
    return this.update(async () => {
      const waiting = [...this.rows.values()].filter(canMoveDubJob).sort((a, b) => order(a) - order(b));
      const index = waiting.findIndex(row => row.id === id);
      if (index < 0 || ![-1, 1].includes(direction) || !waiting[index + direction]) return;
      const other = index + direction;
      [waiting[index], waiting[other]] = [waiting[other], waiting[index]];
      // Renumber together so legacy entries with identical timestamps can also move.
      const next = waiting.find(row => !this.live.has(row.id) && row.status !== "paused");
      if (this.background && next && this.background.id !== next.id) await this.stopBackground(this.background.id);
      const now = Date.now();
      const moved = waiting.map((row, i) => ({ ...row, order: i, updatedAt: now }));
      if (!await idbSetAll(Object.fromEntries(moved.map(row => [prefix + row.id, row])))) throw Error("队列顺序保存失败");
      for (const row of moved) { this.rows.get(row.id).order = row.order; this.rows.get(row.id).updatedAt = row.updatedAt; }
      notifySyncChange({ kind: "idbBatch", keys: moved.map(row => prefix + row.id) });
    });
  }

  remove(id) {
    return this.update(async () => {
      await this.stopBackground(id);
      const keys = [prefix + id, ...archiveKeys(id)];
      if (!await idbDel(keys)) throw Error("删除配音失败");
      this.rows.delete(id);
      notifySyncChange({ kind: "idbDelete", keys, deletedAt: Date.now() });
    });
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
    const selfId = typeof chrome !== "undefined" ? chrome.runtime?.id || "" : "";
    for (;;) {
      await this.writes;
      const row = [...this.rows.values()]
        .filter(r => r.status === "queued" && !this.live.has(r.id) && (!r.ownerId || !selfId || r.ownerId === selfId))
        .sort((a, b) => order(a) - order(b))[0];
      if (!row) return;
      const controller = new AbortController();
      const done = this.processRow(row, controller.signal);
      this.background = { id: row.id, controller, done };
      try {
        await done;
      } finally {
        this.background = null;
      }
    }
  }

  async processRow(row, signal) {
    row.status = "running";
    row.detail = "正在准备音轨";
    try {
      await this.save(row);
      signal.throwIfAborted();
      const expiry = await this.process(row, detail => { row.detail = detail; }, signal);
      signal.throwIfAborted();
      if (!expiry) throw Error("未生成完整音频，可重试补全");
      row.expireAt = expiry;
      row.status = "ready";
      row.detail = "";
    } catch (error) {
      row.status = signal.aborted ? "queued" : "failed";
      row.detail = signal.aborted ? "" : error.message || String(error);
    }
    await this.save(row);
  }
}
