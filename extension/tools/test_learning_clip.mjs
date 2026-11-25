import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeLearningClip } from "../../native/learn-clip.mjs";

const folder = await mkdtemp(path.join(os.tmpdir(), "pagelens-clip-"));
const configPath = path.join(folder, "config.json");
const token = randomBytes(32).toString("hex");
const endpoint = "http://100.100.22.11:4317/api/learn/clips";
const source = "https://example.org/manual?id=1&access_token=private&utm_medium=feed#ch_example";
const clip = { url: source, title: "A manual", quote: "An observation", note: "Understand this" };
let attempts = 0;
async function request(url, options) {
  assert.equal(url.href, endpoint);
  assert.equal(options.redirect, "error");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer " + token);
  assert.deepEqual(JSON.parse(options.body), { ...clip, url: "https://example.org/manual?id=1#ch_example", content: "" });
  attempts++;
  if (attempts === 1) return new Response(null, { status: 503 });
  return Response.json({ duplicate: attempts > 2, readerUrl: "/learn?tab=library&clip=clip-one" });
}
try {
  await writeFile(configPath, JSON.stringify({ endpoint, token }), { mode: 0o600 });
  const send = (payload = clip) => writeLearningClip(payload, { configPath, request });
  assert.match((await send()).error, /503/);
  assert.deepEqual(await send(), { ok: true, duplicate: false, readerUrl: "http://100.100.22.11:4317/learn?tab=library&clip=clip-one" });
  assert.equal((await send()).duplicate, true);
  const receipt = {
    readerUrl: "/learn?tab=library&clip=clip-one", reviewUrl: "/learn?tab=knowledge&topic=ontology&clip=clip-one",
    matchingStatus: "ready", pendingCount: 3, notes: ["private note metadata stays with the learning service"],
  };
  const replyWith = (values, payload = clip) => writeLearningClip(payload, {
    configPath, request: async (_url, options) => {
      if (payload.url.includes("access_token=redact"))
        assert.equal(JSON.parse(options.body).url, "https://example.org/manual");
      return Response.json({ ...receipt, ...values });
    },
  });
  const propagated = await replyWith({});
  assert.equal(propagated.reviewUrl, "http://100.100.22.11:4317" + receipt.reviewUrl);
  assert.equal(propagated.pendingCount, 3);
  assert.equal(propagated.matchingStatus, "ready");
  assert.equal(Object.hasOwn(propagated, "notes"), false);
  assert.equal((await replyWith({matchingStatus:"queued",pendingCount:0})).matchingStatus, "queued");
  assert.equal((await replyWith({reviewUrl:"https://example.org/learn?tab=knowledge&clip=clip-one"})).reviewUrl, undefined);
  assert.equal((await replyWith({reviewUrl:"/learn?tab=knowledge&clip=another-clip"})).reviewUrl, undefined);
  assert.equal((await replyWith({readerUrl:"https://example.org/learn?clip=clip-one"})).ok, false);
  assert.equal((await replyWith({}, {...clip, url:"https://example.org/manual#access_token=redact"})).ok, true);
  const fullPage = await writeLearningClip({ ...clip, quote: "", content: "The previewed page body", history: ["another tab"] }, {
    configPath, request: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.content, "The previewed page body");
      assert.equal(body.quote, "");
      assert.equal(Object.hasOwn(body, "history"), false);
      return Response.json(receipt);
    },
  });
  assert.equal(fullPage.ok, true);
  assert.equal((await send({ ...clip, url: "file:///tmp/local.md" })).ok, false);
  assert.equal((await send({ ...clip, url: "https://name:pw@example.org/" })).ok, false);
  assert.equal((await send({ ...clip, quote: "" })).ok, false);
  assert.equal((await send({ ...clip, quote: "a".repeat(17000) })).ok, false);
  assert.equal(attempts, 3);
  if (process.platform !== "win32") {
    await chmod(configPath, 0o644);
    assert.equal((await send()).ok, false);
    await chmod(configPath, 0o600);
  }
  await writeFile(configPath, JSON.stringify({ endpoint: "http://example.org/api/other", token }));
  assert.equal((await send()).ok, false);
  assert.equal(attempts, 3);
  console.log("PASS learning clip native transport, scoped key, source URL, retry, duplicates and private config");
} finally { await rm(folder, { recursive: true, force: true }); }
