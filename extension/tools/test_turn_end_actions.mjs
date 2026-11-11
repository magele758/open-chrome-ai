import { messageShowsActionRow } from "../lib/turn-end-actions.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const streaming = [
  { role: "user", text: "问" },
  { role: "bot", text: "还在写" },
];
assert(messageShowsActionRow(streaming, 1, true) === false, "streaming tail hides the row");
assert(messageShowsActionRow([{ role: "bot", text: "…" }], 0, true) === false, "placeholder hides the row");

const parts = [
  { role: "user", text: "问" },
  { role: "bot", text: "第一段" },
  { role: "bot", text: "第二段" },
  { role: "user", text: "下一题" },
  { role: "bot", text: "另一条" },
];
assert(messageShowsActionRow(parts, 1, false) === false, "earlier segment has no row");
assert(messageShowsActionRow(parts, 2, false) === true, "row sits on the last segment of the finished reply");
assert(messageShowsActionRow(parts, 4, false) === true, "the next finished reply has its own row");
assert(messageShowsActionRow(parts, 4, true) === false, "the open tail stays hidden while a later turn streams");
assert(messageShowsActionRow(parts, 2, true) === true, "an earlier finished reply keeps its row");
assert(messageShowsActionRow([{ role: "bot", text: "失败", error: true }], 0, false) === false, "errors have no row");

console.log("turn-end-actions ok");
