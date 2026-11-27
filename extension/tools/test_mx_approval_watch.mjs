import assert from "node:assert/strict";
import { test } from "node:test";
import { createMxApprovalWatcher, MX_APPROVAL_WATCH_KEY } from "../lib/agent/mx-approval-watch.js";

const MINUTE = 60_000;
const submittedAt = "2026-11-19T02:00:00.000Z";
const draftId = "1738630710999877196";
const productId = "1738630710999877200";
const sourceId = "1733781903228241493";
const beforeTitle = "Rejilla de pan de acero inoxidable";
const afterTitle = "Rejilla de acero inoxidable para pan, 6 espacios";
const action = "ptc_mx_seller_action";
const publishJob = {
  id: "publish-1", action, createdAt: submittedAt,
  request: {
    mode: "publish_draft", sourceId, draftId,
    offer: {
      brand: "无品牌", packagedWeightGrams: 480, packageCm: { length: 24, width: 14, height: 12 },
      skus: [{ label: "Silver / 1 piece", priceMXN: 1200, stock: 1 }],
    },
  },
};
const optimizationJob = {
  id: "optimize-1", action, createdAt: submittedAt,
  request: {
    mode: "optimize_listing", productId, beforeTitle, afterTitle,
    editorUrl: "https://seller.tiktokshopglobalselling.com/product/edit/" + productId + "?shop_region=MX",
  },
};
const publishResult = status => ({
  ok: true,
  result: {
    mode: "publish_draft", runtime: "pagelens-native", sourceId, draftId, productId,
    productCandidateId: productId, intentAt: submittedAt, status, verified: true, submitted: true,
    readback: { productId, status, title: beforeTitle },
  },
});
const optimizationResult = {
  ok: true,
  result: {
    mode: "optimize_listing", runtime: "pagelens-native", productId, title: afterTitle,
    status: "optimization_under_review", submitted: true, verified: false,
    review: { productId, title: afterTitle, status: "under_review" },
  },
};
const active = ({ id = productId, title = beforeTitle, verified = true } = {}) => ({
  productId: id, status: "active", title, verified,
});

async function fixture({ enabled = true, initial } = {}) {
  let time = Date.parse(submittedAt);
  const records = initial ? { [MX_APPROVAL_WATCH_KEY]: structuredClone(initial) } : {};
  const notices = [];
  const storage = {
    async get(key) {
      return Object.hasOwn(records, key) ? { [key]: structuredClone(records[key]) } : {};
    },
    async set(values) {
      Object.assign(records, structuredClone(values));
    },
  };
  const openWorker = () => createMxApprovalWatcher({
    storage, now: () => time, notify: async notice => { notices.push(structuredClone(notice)); },
  });
  if (enabled) await openWorker().setEnabled(true);
  return {
    openWorker, records, now: () => time,
    advance: ms => { time += ms; },
    notices,
  };
}

async function expectNoRead(watcher) {
  let reads = 0;
  await watcher.poll(async () => { reads += 1; });
  assert.equal(reads, 0, "No seller status read is due");
}

test("checks the published product ID after 60 seconds and notifies once when active", async () => {
  const { openWorker, advance, notices } = await fixture();
  const watcher = openWorker();
  await watcher.record(publishJob, publishResult("under_review"));
  assert.deepEqual(notices, []);
  await expectNoRead(watcher);
  advance(MINUTE - 1);
  await expectNoRead(watcher);
  advance(1);

  const checked = [];
  await watcher.poll(async id => {
    checked.push(id);
    return { ok: true, result: active() };
  });
  assert.deepEqual(checked, [productId]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].productId, productId);
  assert.equal(notices[0].mode, "publish_draft");
  assert.equal(notices[0].status, "active");

  advance(MINUTE);
  await expectNoRead(openWorker());
  assert.equal(notices.length, 1);
});

test("empty, unrelated or failed outcomes leave no pending seller reads", async () => {
  const { openWorker, advance, notices } = await fixture();
  const watcher = openWorker();
  await expectNoRead(watcher);
  await watcher.record({ ...publishJob, action: "bridge_call" }, publishResult("under_review"));
  await watcher.record(publishJob, { ...publishResult("under_review"), ok: false });
  advance(MINUTE);
  await expectNoRead(watcher);
  assert.deepEqual(notices, []);
});

test("only the exact product with its approved optimized title can notify", async () => {
  const { openWorker, advance, notices } = await fixture();
  const watcher = openWorker();
  await watcher.record(optimizationJob, optimizationResult);
  await expectNoRead(watcher);

  const checked = [];
  advance(MINUTE);
  await watcher.poll(async id => {
    checked.push(id);
    return active({ id: draftId, title: afterTitle });
  });
  assert.deepEqual(checked, [productId]);
  assert.deepEqual(notices, []);

  advance(MINUTE);
  await watcher.poll(async () => active());
  assert.deepEqual(notices, []);

  advance(MINUTE);
  await watcher.poll(async () => active({ title: afterTitle }));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].productId, productId);
  assert.equal(notices[0].mode, "optimize_listing");
  assert.equal(notices[0].title, afterTitle);
});

test("deduplicates repeat immediate active receipts after a worker restart", async () => {
  const { openWorker, advance, notices } = await fixture();
  await openWorker().record(publishJob, publishResult("active"));
  assert.equal(notices.length, 1);
  await openWorker().record({ ...publishJob, id: "publish-replayed" }, publishResult("active"));
  assert.equal(notices.length, 1);
  advance(MINUTE);
  await expectNoRead(openWorker());
});

test("persists the retry gate and only accepts a verified active read across restarts", async () => {
  const { openWorker, advance, notices } = await fixture();
  await openWorker().record(publishJob, publishResult("under_review"));
  advance(MINUTE);

  const checked = [];
  await openWorker().poll(async id => {
    checked.push(id);
    throw Error("Seller read deferred by the inbox gate");
  });
  assert.deepEqual(checked, [productId]);
  assert.deepEqual(notices, []);

  const restarted = openWorker();
  await expectNoRead(restarted);
  advance(MINUTE - 1);
  await expectNoRead(restarted);
  advance(1);
  await restarted.poll(async id => {
    checked.push(id);
    return active({ verified: false });
  });
  assert.deepEqual(checked, [productId, productId]);
  assert.deepEqual(notices, []);

  advance(MINUTE);
  await openWorker().poll(async id => {
    checked.push(id);
    return active();
  });
  assert.deepEqual(checked, [productId, productId, productId]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].productId, productId);
});

test("new installs default off and retain manual status control without starting tracking", async () => {
  const { openWorker, advance, notices } = await fixture({ enabled: false });
  const watcher = openWorker();
  assert.equal((await watcher.getState()).enabled, false);
  await watcher.record(publishJob, publishResult("active"));
  advance(MINUTE);
  await expectNoRead(watcher);
  assert.deepEqual((await watcher.getState()).watches, []);
  assert.deepEqual(notices, []);
});

test("migrates old pending and approved records before opt-in and resets the old retry gate", async () => {
  const time = Date.parse(submittedAt);
  const legacy = { key: "publish:" + productId + ":" + submittedAt, intentAt: submittedAt,
    mode: "publish_draft", jobId: "old", productId, nextCheckAt: time };
  const initial = { nextPollAt: 8640000000000000, watches: [legacy,
    { ...legacy, key: "earlier-approved", notifiedAt: time - MINUTE }] };
  const { openWorker, records } = await fixture({ enabled: false, initial });
  const watcher = openWorker();
  const migrated = await watcher.getState();
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.nextPollAt, 0);
  assert.equal(records[MX_APPROVAL_WATCH_KEY].nextPollAt, 0);
  assert.deepEqual(migrated.watches.map(watch => watch.state), ["disabled", "approved"]);
  assert.equal(migrated.watches[1].finishedAt, time - MINUTE);
  await watcher.setEnabled(true);
  await watcher.record(publishJob, publishResult("active"));
  await expectNoRead(openWorker());
  assert.deepEqual((await openWorker().getState()).watches.map(watch => watch.state), ["disabled", "approved"]);
});

test("cancels one pending item, disables the rest and cannot resume either after restart", async () => {
  const { openWorker, advance, now, notices } = await fixture();
  const watcher = openWorker();
  await watcher.record(publishJob, publishResult("under_review"));
  await watcher.record(optimizationJob, optimizationResult);
  const initial = await watcher.getState();
  assert.equal(initial.watches[0].startedAt, now());
  assert.equal(initial.watches[0].expiresAt, now() + 24 * 60 * MINUTE);
  assert.equal(initial.watches[0].title, beforeTitle);
  assert.equal(initial.watches[1].lastStatus, "optimization_under_review");
  const cancelled = await watcher.cancel(initial.watches[0].key);
  assert.deepEqual(cancelled.watches.map(watch => watch.state), ["cancelled", "watching"]);
  advance(MINUTE);
  const disabled = await watcher.setEnabled(false);
  assert.deepEqual(disabled.watches.map(watch => watch.state), ["cancelled", "disabled"]);
  assert.equal(disabled.watches[1].finishedAt, now());
  const restarted = openWorker();
  await restarted.setEnabled(true);
  await restarted.record(publishJob, publishResult("active"));
  await restarted.record(optimizationJob, optimizationResult);
  await expectNoRead(restarted);
  assert.deepEqual(notices, []);
});

test("no open list, read errors and absence on the visible page are recorded until expiry", async () => {
  const { openWorker, advance, now } = await fixture();
  const watcher = openWorker();
  await watcher.record(publishJob, publishResult("under_review"));
  const statuses = ["no_page", "unreadable", "access_disabled", "stale_page", "read_error", "not_found", "not_found", "not_found", "under_review"];
  for (const status of statuses) {
    advance(MINUTE);
    await watcher.poll(async () => {
      if (["no_page", "unreadable", "access_disabled", "stale_page"].includes(status)) return { status };
      if (status === "read_error") throw Error("tab closed");
      return { productId, status, verified: status !== "not_found" };
    });
    const [watch] = (await watcher.getState()).watches;
    assert.equal(watch.lastStatus, status);
    assert.equal(watch.lastCheckedAt, now());
    assert.equal(watch.state, "watching");
  }
  advance(24 * 60 * MINUTE - statuses.length * MINUTE);
  await expectNoRead(openWorker());
  const [expired] = (await watcher.getState()).watches;
  assert.equal(expired.state, "expired");
  assert.equal(expired.finishedAt, now());
});

test("only a verified explicit terminal state stops a publish watch", async () => {
  for (const terminal of ["rejected", "deleted", "inactive"]) {
    const { openWorker, advance, notices } = await fixture();
    const watcher = openWorker();
    await watcher.record(publishJob, publishResult("under_review"));
    for (const read of [
      { status: terminal, verified: false, productId },
      { status: terminal, verified: true, productId: draftId },
      { status: "attention", statusLabel: "需要关注", verified: true, productId },
    ]) {
      advance(MINUTE);
      await watcher.poll(async () => read);
      assert.equal((await watcher.getState()).watches[0].state, "watching");
    }
    advance(MINUTE);
    const result = terminal === "rejected"
      ? { status: "attention", statusLabel: "审核未通过\n详情" } : { status: terminal };
    await watcher.poll(async () => ({ ...result, verified: true, productId }));
    assert.equal((await watcher.getState()).watches[0].state, terminal);
    assert.deepEqual(notices, []);
    advance(MINUTE);
    await expectNoRead(openWorker());
  }
});

test("an explicit verified delisting ends both pending watches for that exact product", async () => {
  const { openWorker, advance } = await fixture();
  const watcher = openWorker();
  await watcher.record(publishJob, publishResult("under_review"));
  await watcher.record(optimizationJob, optimizationResult);
  const request = { id: "delist", action, request: { mode: "delist_listing", productId } };
  const read = { productId, status: "inactive", verified: true, title: beforeTitle };
  await watcher.record(request, { ok: true, result: { ...read, productId: draftId } });
  assert.deepEqual((await watcher.getState()).watches.map(w => w.state), ["watching", "watching"]);
  await watcher.record(request, { ok: true, result: read });
  assert.deepEqual((await watcher.getState()).watches.map(w => w.state), ["inactive", "inactive"]);
  advance(MINUTE);
  await expectNoRead(watcher);
});

test("disable or cancellation wins against a delayed response", async () => {
  for (const action of ["disable", "cancel"]) {
    const { openWorker, advance, notices } = await fixture();
    const watcher = openWorker();
    await watcher.record(publishJob, publishResult("under_review"));
    advance(MINUTE);
    let complete, started;
    const reading = new Promise(resolve => { started = resolve; });
    const check = watcher.poll(() => {
      started();
      return new Promise(resolve => { complete = resolve; });
    });
    await reading;
    if (action === "disable") await watcher.setEnabled(false);
    else await watcher.cancel((await watcher.getState()).watches[0].key);
    complete(active());
    await check;
    assert.deepEqual(notices, []);
    assert.equal((await watcher.getState()).watches[0].state, action === "disable" ? "disabled" : "cancelled");
  }
});

test("bounds finished history while preserving pending records", async () => {
  const { openWorker } = await fixture();
  const watcher = openWorker();
  await watcher.record(optimizationJob, optimizationResult);
  for (let n = 0; n < 105; n++) {
    const receipt = publishResult("active");
    receipt.result.productId = String(100000000000 + n);
    await watcher.record(publishJob, receipt);
  }
  const { watches } = await watcher.getState();
  assert.equal(watches.length, 101);
  assert.equal(watches[0].state, "watching");
  assert.equal(watches[1].productId, "100000000005");
});

test("one passive read applies only to submissions that predate its document", async () => {
  const { openWorker, advance, now, notices } = await fixture();
  const watcher = openWorker();
  const startedAt = now();
  await watcher.record(publishJob, publishResult("under_review"));
  advance(MINUTE / 2);
  const documentAt = now();
  advance(10);
  await watcher.record({ ...optimizationJob, createdAt: new Date(now()).toISOString() }, optimizationResult);
  advance(MINUTE / 2);
  await watcher.poll(async (id, since) => {
    assert.equal(id, productId);
    assert.equal(since, startedAt);
    return { ...active({ title: afterTitle }), documentAt };
  });
  assert.equal(notices.length, 1);
  const [published, editing] = (await watcher.getState()).watches;
  assert.equal(published.state, "approved");
  assert.equal(editing.state, "watching");
  assert.equal(editing.lastStatus, "stale_page");
  advance(MINUTE);
  await watcher.poll(async () => ({ status: "deleted", productId, verified: true, documentAt }));
  assert.equal((await watcher.getState()).watches[1].state, "watching");
  const manual = { id: "refresh", action, request: { mode: "listing_status", productId } };
  await watcher.record(manual, { ok: true, result: active({ title: afterTitle }) });
  assert.equal((await watcher.getState()).watches[1].state, "approved");
  assert.equal(notices.length, 2);
});
