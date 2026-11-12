function replyTextReady(msg) {
  if (!msg || msg.role !== "bot" || msg.error) return false;
  const text = String(msg.text || "").trim();
  return Boolean(text) && text !== "…";
}

function laterBotInTurn(messages, index) {
  for (let i = index + 1; i < messages.length; i += 1) {
    const role = messages[i]?.role;
    if (role === "user") return false;
    if (role === "bot") return true;
  }
  return false;
}

/** One action row, after the last finished bot message of a turn. */
export function messageShowsActionRow(messages, index, busy) {
  if (!replyTextReady(messages[index])) return false;
  if (busy && index === messages.length - 1) return false;
  return !laterBotInTurn(messages, index);
}
