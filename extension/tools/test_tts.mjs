import assert from 'node:assert/strict';
import { synthesizeTts, waitGradioCall } from '../lib/tts.js';

// Exercise the complete client exchange, including the Gradio 5.45 queue rule.
// A successful POST alone does not mean GET /call/{event_id} can read its queue.
const ref = { name: 'voice.wav', bytes: 4, buffer: new Uint8Array([1, 2, 3, 4]), type: 'audio/wav' };
function request(result) {
  const r = { result };
  queueMicrotask(() => r.onsuccess());
  return r;
}
globalThis.indexedDB = {
  open: () => request({ transaction: () => ({ objectStore: () => ({ get: () => request(ref) }) }) }),
};
const baseUrl = 'https://tts.example.test';
let uploads = 0;
const uploadedBytes = [];
let submission;
let failDownload = false;
let failQueue = false;
let wrapUpdate = true;
const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  if (path === '/gradio_api/upload') {
    uploads++;
    assert(options.body.get('files') instanceof Blob);
    uploadedBytes.push([...new Uint8Array(await options.body.get('files').arrayBuffer())]);
    return Response.json(['/tmp/gradio/reference.wav']);
  }
  if (path === '/gradio_api/call/gen_single') {
    submission = JSON.parse(options.body);
    assert.equal(submission.data[1].path, '/tmp/gradio/reference.wav');
    return Response.json({ event_id: 'event-123' });
  }
  if (path === '/gradio_api/call/gen_single/event-123') {
    // Real server keys its queue by session_hash when supplied, but this GET
    // route looks it up by event_id. Reproduce the user's HTTP-200 SSE error.
    if (submission.session_hash || failQueue) {
      return new Response('event: error\ndata: "404: Not Found"\n\n');
    }
    const file = { path: '/tmp/output.wav', url: '/gradio_api/file=/tmp/output.wav' };
    const result = wrapUpdate ? { __type__: 'update', visible: true, value: file } : file;
    const event = `event: heartbeat\ndata: null\n\nevent: complete\ndata: ${JSON.stringify([result])}\n\n`;
    const bytes = new TextEncoder().encode(event);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17, 63));
      controller.enqueue(bytes.slice(63));
      controller.close();
    } }));
  }
  if (path === '/gradio_api/file=/tmp/output.wav') {
    return failDownload ? new Response('Not Found', { status: 404 }) : new Response(audio, { headers: { 'Content-Type': 'audio/wav' } });
  }
  throw new Error(`Unexpected route ${path}`);
};
const out = await synthesizeTts({ baseUrl }, '你好，这是同传测试。');
assert.equal(Object.hasOwn(submission, 'session_hash'), false);
assert.equal(submission.data.length, 26);
assert.deepEqual(new Uint8Array(await out.blob.arrayBuffer()), audio);
wrapUpdate = false;
await synthesizeTts({ baseUrl }, '这是第二段。');
assert.equal(uploads, 1, 'reference audio is reused across segments');
const beforeTemporary = uploads;
await synthesizeTts({ baseUrl }, '第一段临时参考', { referenceBlob: new Blob([new Uint8Array([7, 8])], { type: 'audio/wav' }) });
await synthesizeTts({ baseUrl }, '第二段临时参考', { referenceBlob: new Blob([new Uint8Array([9, 0])], { type: 'audio/wav' }) });
assert.equal(uploads, beforeTemporary + 2, 'same-size segment references never share an upload cache');
assert.deepEqual(uploadedBytes.slice(-2), [[7, 8], [9, 0]]);
await synthesizeTts({ baseUrl }, '仍然使用保存的音色');
assert.equal(uploads, beforeTemporary + 2, 'temporary references do not overwrite saved voice cache');
failDownload = true;
await assert.rejects(synthesizeTts({ baseUrl }, '下载测试'), /下载合成音频失败：404/);
failDownload = false;
failQueue = true;
await assert.rejects(synthesizeTts({ baseUrl }, '队列测试'), /配音生成失败：404: Not Found/);
console.log('ok tts: Gradio event queue, audio download, reference reuse, stage errors');

const routedFetch = globalThis.fetch;
for (const status of [401, 503]) {
  let submissions = 0;
  const previousUploads = uploads;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname === '/gradio_api/call/gen_single') {
      submissions++;
      return new Response('service error', { status });
    }
    return routedFetch(url, options);
  };
  await assert.rejects(synthesizeTts({ baseUrl }, '服务故障'), new RegExp(String(status)));
  assert.equal(submissions, 1, 'provider failures do not trigger nested submission retries');
  assert.equal(uploads, previousUploads, 'provider failures do not invalidate a saved voice reference');
}

// Real HTTP chunks need not line up with SSE boundaries or UTF-8 characters.
const file = [{ url: '/中文.wav' }];
for (const separator of ['\n', '\r\n']) {
  let cancelled = false;
  const text = `event: heartbeat${separator}data: null${separator}${separator}event: complete${separator}data: ${JSON.stringify(file)}`;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of new TextEncoder().encode(text)) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  }));
  assert.deepEqual(await waitGradioCall(baseUrl, 'gen_single', 'e'), file, 'EOF flushes a complete final event without a blank line');
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(text + separator + separator)); },
    cancel() { cancelled = true; },
  }));
  assert.deepEqual(await waitGradioCall(baseUrl, 'gen_single', 'e'), file);
  assert(cancelled, 'completed SSE releases an otherwise open connection');
}
for (const text of ['event: heartbeat\ndata: null\n\n', 'event: generating\ndata: ["partial.wav"]\n\n', 'event: complete\ndata: [{"url":"cut']) {
  globalThis.fetch = async () => new Response(text);
  await assert.rejects(waitGradioCall(baseUrl, 'gen_single', 'e'), /连接中断/);
}
console.log('PASS TTS stream: CRLF, split UTF-8, final event, early disconnect and connection release');
