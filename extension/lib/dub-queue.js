import { idbSet, idbValuesWithPrefix } from "./idb-kv.js";

const prefix = "dub-queue:";
export async function loadDubJobs() {
  return (await idbValuesWithPrefix(prefix)).sort((a, b) => a.added - b.added);
}
export async function saveDubJob(row) {
  if (!await idbSet(prefix + row.id, row)) throw Error("预处理队列保存失败，请检查浏览器存储空间");
}
export const unfinished = row => ["queued", "running"].includes(row.status);

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
      if (!row) return;
      row.status = "running";
      row.detail = "正在准备音轨";
      try {
        await this.save(row);
        const expiry = await this.process(row, detail => { row.detail = detail; });
        if (!expiry) throw Error("未生成完整音频，可重试补全");
        row.expireAt = expiry;
        row.status = "ready";
        row.detail = "";
      } catch (error) {
        row.status = "failed";
        row.detail = error.message || String(error);
      }
      await this.save(row);
    }
  }
}
