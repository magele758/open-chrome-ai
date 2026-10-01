import assert from "node:assert/strict";
import { createSwClipboard } from "../lib/clipboard-sw.js";

function makeChrome({ contexts = [], respond }) {
  const log = [];
  const state = { contexts: [...contexts] };
  const api = {
    runtime: {
      getURL: (p) => `chrome-extension://abc/${p}`,
      getContexts: async () => state.contexts,
      sendMessage: async (msg) => {
        log.push(msg.type);
        return respond(msg);
      },
    },
    offscreen: {
      createDocument: async ({ url }) => {
        log.push("create");
        state.contexts = [{ documentUrl: `chrome-extension://abc/${url}` }];
      },
      closeDocument: async () => {
        log.push("close");
        state.contexts = [];
      },
    },
  };
  return { api, log };
}
const noSleep = async () => {};

// 1. copy-event strategy succeeds first; offscreen doc is created and closed
{
  const { api, log } = makeChrome({ respond: () => ({ ok: true }) });
  const native = async () => assert.fail("native must not run");
  const res = await createSwClipboard({ chromeApi: api, native, sleep: noSleep }).write({ html: "<b>x</b>", text: "x" });
  assert.equal(res.via, "offscreen-copy");
  assert.deepEqual(log, ["create", "pl.clipboard.copyEvent", "close"]);
}

// 2. falls through copy → api → native, recording every attempt
{
  const { api } = makeChrome({ respond: () => ({ ok: false, error: "Document is not focused" }) });
  const natives = [];
  const native = async (m) => {
    natives.push(m);
    return { ok: true };
  };
  const res = await createSwClipboard({ chromeApi: api, native, sleep: noSleep }).write({ html: "<i>y</i>" });
  assert.equal(res.via, "native");
  assert.deepEqual(res.attempts.map((a) => a.via), ["offscreen-copy", "offscreen-api", "native"]);
  assert.equal(natives[0].op, "clipboard_write");
}

// 3. a foreign offscreen document (audio playback) is never closed or replaced
{
  const { api, log } = makeChrome({ contexts: [{ documentUrl: "chrome-extension://abc/offscreen/audio.html" }], respond: () => ({ ok: true }) });
  const res = await createSwClipboard({ chromeApi: api, native: async () => ({ ok: true }), sleep: noSleep }).write({ html: "<p>z</p>" });
  assert.equal(res.via, "native");
  assert.ok(!log.includes("close") && !log.includes("create"));
  assert.match(res.attempts[0].error, /占用/);
}

// 4. everything fails → error carries attempts
{
  const { api } = makeChrome({ respond: () => ({ ok: false, error: "nope" }) });
  await assert.rejects(
    () => createSwClipboard({ chromeApi: api, native: async () => ({ ok: false, error: "no host" }), sleep: noSleep }).write({ text: "t" }),
    (err) => err.attempts.length === 3 && /no host/.test(err.message),
  );
}

await assert.rejects(() => createSwClipboard({ chromeApi: makeChrome({ respond: () => ({}) }).api }).write({}), /为空/);

console.log("clipboard-sw tests passed");
