import assert from "node:assert/strict";
import { test } from "node:test";
import { DubQueue } from "../lib/dub-queue.js";
import { describeClip, topicNeighborhood } from "../lib/clipping-graph.js";

test("[AC:preprocess-knowledge#AC-1] FIFO survives interruption and duplicate enqueue", async () => {
  const stored = new Map([["first", { id: "first", status: "running", added: 1 }]]);
  const order = [];
  let active = 0;
  const queue = new DubQueue({
    load: async () => [...stored.values()],
    save: async row => stored.set(row.id, structuredClone(row)),
    process: async row => {
      assert.equal(++active, 1);
      order.push(row.id);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      if (row.id === "second") throw Error("failed");
      return Date.now() + 10000;
    },
  });
  await Promise.all(["second", "second", "third"].map(id => queue.enqueue({ id })));
  await queue.drain();
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.equal(stored.get("second").status, "failed");
  assert.equal(stored.get("third").status, "ready");
});

test("[AC:preprocess-knowledge#AC-2] a partial or unsaved archive cannot become ready", async () => {
  const rows = new Map();
  const queue = new DubQueue({ load: async () => [], save: async row => rows.set(row.id, {...row}), process: async () => undefined });
  await queue.enqueue({ id: "partial" });
  await queue.drain();
  assert.equal(rows.get("partial").status, "failed");
});

test("[AC:preprocess-knowledge#AC-3] content connects untagged clips with sources and related topics", () => {
  const clips = [{ id: "one", content: "神经网络 机器学习 神经网络", tags: ["实验"] }, { id: "two", content: "机器学习与神经网络" }];
  const rows = clips.map(c => ({ ...c, ...describeClip(c) }));
  const shared = rows[0].topics.find(t => rows[1].topics.includes(t));
  assert.ok(shared);
  assert.ok(rows[0].domains.includes("人工智能"));
  const graph = topicNeighborhood(rows, shared);
  assert.deepEqual(graph.sources.map(s => s.id), ["one", "two"]);
  assert.ok(graph.related.some(r => r.topic === "实验" && r.count === 1));
});
