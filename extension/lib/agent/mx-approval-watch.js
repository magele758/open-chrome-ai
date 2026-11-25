export const MX_APPROVAL_WATCH_KEY = "agentMxApprovalWatch";
const CHECK_INTERVAL_MS = 60_000;
const MAX_WATCH_MS = 24 * 60 * CHECK_INTERVAL_MS;
const MAX_FINISHED = 100;
const EXACT_ID = /^\d{12,22}$/;
const PUBLISH_STATES = ["active", "under_review", "inactive", "attention", "rejected", "deleted"];
const EDITED_STATES = ["active", "inactive"];
const READ_UNAVAILABLE = ["no_page", "unreadable", "access_disabled", "stale_page"];

function exactId(value) {
  return typeof value === "string" && EXACT_ID.test(value);
}

function newWatch(job, result, time) {
  const { request } = job;
  const { productId, submitted, verified, status, title } = result;
  if (!exactId(productId)) return null;
  const common = { mode: request.mode, productId, jobId: job.id, state: "watching", nextCheckAt: time + CHECK_INTERVAL_MS };
  if (request.mode === "publish_draft") {
    const startedAt = Date.parse(result.intentAt);
    if (submitted !== true || verified !== true || !PUBLISH_STATES.includes(status) ||
        typeof result.intentAt !== "string" || !Number.isFinite(startedAt)) return null;
    if ((result.draftId != null && request.draftId !== result.draftId) ||
        (result.sourceId != null && request.sourceId !== result.sourceId)) return null;
    return { ...common, key: "publish:" + productId + ":" + result.intentAt, intentAt: result.intentAt,
      startedAt: Math.min(startedAt, time) };
  }
  if (request.mode !== "optimize_listing" || request.productId !== productId || result.changed === false ||
      typeof request.afterTitle !== "string" || !request.afterTitle.trim() || title !== request.afterTitle) return null;
  const review = result.review;
  const pending = status === "optimization_under_review" && submitted === true &&
    review?.productId === productId && review.title === title && review.status === "under_review";
  const changed = result.changed === true && verified === true && EDITED_STATES.includes(status);
  if (!pending && !changed) return null;
  const createdAt = Date.parse(job.createdAt);
  return { ...common, key: "optimize:" + job.id, title, startedAt: Number.isFinite(createdAt) ? Math.min(createdAt, time) : time };
}

function finish(watch, state, time) {
  watch.state = state;
  watch.finishedAt = time;
  delete watch.nextCheckAt;
}

function approvalStatus(result) {
  const label = result.statusLabel ?? (result.readback?.productId === result.productId ? result.readback.statusLabel : "");
  if (result.status === "attention" && /^审核未通过(?:\s|$)/.test(label))
    return "rejected";
  return result.status;
}

export function createMxApprovalWatcher({ storage = chrome.storage.local, now = Date.now, notify }) {
  let queue = Promise.resolve();

  function serialized(run) {
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  }

  async function save(state) {
    const finished = state.watches.filter(watch => watch.state !== "watching");
    if (finished.length > MAX_FINISHED) {
      const keep = new Set(finished.reverse().sort((a, b) => b.finishedAt - a.finishedAt).slice(0, MAX_FINISHED));
      state.watches = state.watches.filter(watch => watch.state === "watching" || keep.has(watch));
    }
    await storage.set({ [MX_APPROVAL_WATCH_KEY]: state });
    return state;
  }

  async function load() {
    const data = (await storage.get(MX_APPROVAL_WATCH_KEY))?.[MX_APPROVAL_WATCH_KEY];
    const state = {
      enabled: data?.enabled === true,
      ...(Number.isFinite(data?.enabledAt) && { enabledAt: data.enabledAt }),
      watches: Array.isArray(data?.watches) ? data.watches : [],
      nextPollAt: data?.enabled === true && Number.isFinite(data?.nextPollAt) ? data.nextPollAt : 0,
    };
    const time = now();
    let changed = data != null && data.enabled !== state.enabled;
    for (const watch of state.watches) {
      if (!watch.state) {
        // Older versions implicitly watched every submission. Preserve the history and end those implicit watches.
        const startedAt = Date.parse(watch.intentAt);
        if (Number.isFinite(startedAt)) watch.startedAt = startedAt;
        finish(watch, watch.notifiedAt != null ? "approved" : "disabled", watch.notifiedAt ?? time);
      } else if (watch.state === "watching" && !state.enabled) {
        finish(watch, "disabled", time);
      } else if (watch.state === "watching" && (!Number.isFinite(watch.expiresAt) || watch.expiresAt <= time)) {
        finish(watch, "expired", time);
      } else {
        continue;
      }
      changed = true;
    }
    return changed ? save(state) : state;
  }

  async function observe(watch, result, time, { delisted = false, passive = false } = {}) {
    watch.lastCheckedAt = time;
    if (passive && Number.isFinite(result.documentAt) && result.documentAt < watch.startedAt) {
      watch.lastStatus = "stale_page";
      return;
    }
    const status = approvalStatus(result);
    watch.lastStatus = status;
    if (result.verified !== true) return;
    const title = result.title ?? (result.readback?.productId === watch.productId ? result.readback.title : undefined);
    if (watch.mode === "publish_draft" && typeof title === "string" && title) watch.title = title;
    if (["rejected", "deleted"].includes(status) ||
        (status === "inactive" && (watch.mode === "publish_draft" || delisted))) {
      finish(watch, status, time);
      return;
    }
    const approved = watch.mode === "publish_draft" ? status === "active"
      : EDITED_STATES.includes(status) && title === watch.title;
    if (!approved) return;
    try {
      await notify({
        mode: watch.mode, productId: watch.productId, status, jobId: watch.jobId,
        ...(watch.title && { title: watch.title }), ...(watch.intentAt && { intentAt: watch.intentAt }),
      });
    } catch {
      watch.lastStatus = "notification_failed";
      return;
    }
    watch.notifiedAt = time;
    finish(watch, "approved", time);
  }

  async function observeProduct(state, result, options) {
    const pending = state.watches.filter(watch => watch.state === "watching" && watch.productId === result.productId);
    if (!pending.length) return;
    for (const watch of pending) await observe(watch, result, now(), options);
    await save(state);
  }

  return {
    getState: () => serialized(load),

    setEnabled(enabled) {
      return serialized(async () => {
        const state = await load();
        if (state.enabled === (enabled === true)) return state;
        state.enabled = enabled === true;
        state.nextPollAt = 0;
        const time = now();
        if (state.enabled) {
          state.enabledAt = time;
        } else {
          for (const watch of state.watches) {
            if (watch.state === "watching") finish(watch, "disabled", time);
          }
        }
        return save(state);
      });
    },

    cancel(key) {
      return serialized(async () => {
        const state = await load();
        const watch = state.watches.find(item => item.key === key && item.state === "watching");
        if (!watch) return state;
        finish(watch, "cancelled", now());
        return save(state);
      });
    },

    record(job, outcome) {
      return serialized(async () => {
        const result = outcome?.ok === true && outcome.result;
        if (job?.action !== "ptc_mx_seller_action" || !job.request ||
            typeof job.id !== "string" || !job.id || !result) return;
        const state = await load();
        if (!state.enabled) return;
        const { mode, productId } = job.request;
        if (mode === "listing_status" || mode === "delist_listing") {
          if (!exactId(productId) || productId !== result.productId || typeof result.status !== "string") return;
          return observeProduct(state, result, { delisted: mode === "delist_listing" });
        }
        const watch = newWatch(job, result, now());
        if (!watch) return;
        const existing = state.watches.find(item => item.key === watch.key);
        if (existing && (existing.state !== "watching" || existing.productId !== watch.productId ||
            (mode === "optimize_listing" && existing.title !== watch.title))) return;
        if (!existing) {
          watch.expiresAt = watch.startedAt + MAX_WATCH_MS;
          if (watch.startedAt < (state.enabledAt ?? 0) || watch.expiresAt <= now()) return;
          state.watches.push(watch);
          await save(state);
        }
        await observe(existing ?? watch, result, now());
        await save(state);
      });
    },

    async poll(readStatus) {
      const attempt = await serialized(async () => {
        const state = await load();
        const time = now();
        if (!state.enabled || state.nextPollAt > time) return;
        const due = state.watches.filter(watch => watch.state === "watching" && watch.nextCheckAt <= time)
          .sort((a, b) => a.nextCheckAt - b.nextCheckAt)[0];
        if (!due) return;
        state.nextPollAt = due.nextCheckAt = time + CHECK_INTERVAL_MS;
        await save(state);
        return { key: due.key, productId: due.productId, nextCheckAt: due.nextCheckAt, startedAt: due.startedAt };
      });
      if (!attempt) return;

      // Allow cancellation and disabling while a browser read is in flight.
      let result;
      try {
        const reply = await readStatus(attempt.productId, attempt.startedAt);
        result = reply?.ok === undefined ? reply : reply.ok === true ? reply.result : null;
      } catch { /* The failed attempt is visible in the tracking history. */ }
      return serialized(async () => {
        const state = await load();
        const watch = state.watches.find(item => item.key === attempt.key);
        if (!state.enabled || watch?.state !== "watching" || watch.nextCheckAt !== attempt.nextCheckAt) return;
        if (result?.productId === watch.productId && typeof result.status === "string") {
          return observeProduct(state, result, { passive: true });
        }
        watch.lastCheckedAt = now();
        watch.lastStatus = READ_UNAVAILABLE.includes(result?.status) ? result.status : "read_error";
        return save(state);
      });
    },
  };
}
