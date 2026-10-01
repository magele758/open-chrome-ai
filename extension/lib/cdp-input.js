/** CDP Input.* 参数构造：按键组合、鼠标序列。纯函数，便于测试。 */

const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

/** Ctrl/Cmd + 字母 对应的编辑命令；合成按键不会触发原生快捷键，必须显式带上。 */
const EDIT_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

export function parseKey(token) {
  const name = String(token || "").trim();
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return { ...named };
  const fn = /^f(\d{1,2})$/i.exec(name);
  if (fn && Number(fn[1]) >= 1 && Number(fn[1]) <= 12) {
    return { key: `F${fn[1]}`, code: `F${fn[1]}`, vk: 111 + Number(fn[1]) };
  }
  if (name.length === 1) {
    const upper = name.toUpperCase();
    if (/[A-Z]/.test(upper)) return { key: name, code: `Key${upper}`, vk: upper.charCodeAt(0), text: name };
    if (/[0-9]/.test(name)) return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0), text: name };
    return { key: name, code: "", vk: name.charCodeAt(0), text: name };
  }
  throw new Error(`不认识的按键：${name}`);
}

/** "Control+Shift+A" / "Enter" / "Meta+V" → { modifiers, key } */
export function parseCombo(combo) {
  const parts = String(combo || "").split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("按键不能为空");
  // 单独的 "+" 键写成 "Shift++" 这种情形不支持，请用 "Shift+=".
  const keyToken = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (!bit) throw new Error(`不认识的修饰键：${part}`);
    modifiers |= bit;
  }
  return { modifiers, key: parseKey(keyToken) };
}

/** 一个组合键的 CDP 事件序列。 */
export function keyEvents(combo) {
  const { modifiers, key } = parseCombo(combo);
  const accel = modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta);
  const printable = key.text && !accel && !(modifiers & MODIFIER_BITS.alt);
  const base = {
    modifiers,
    key: modifiers & MODIFIER_BITS.shift && key.key.length === 1 ? key.key.toUpperCase() : key.key,
    code: key.code,
    windowsVirtualKeyCode: key.vk,
    nativeVirtualKeyCode: key.vk,
  };
  const down = { ...base, type: printable ? "keyDown" : "rawKeyDown" };
  if (printable) down.text = modifiers & MODIFIER_BITS.shift ? key.text.toUpperCase() : key.text;
  if (accel && key.key.length === 1) {
    const command =
      key.key.toLowerCase() === "z" && modifiers & MODIFIER_BITS.shift ? "redo" : EDIT_COMMANDS[key.key.toLowerCase()];
    if (command) down.commands = [command];
  }
  return [down, { ...base, type: "keyUp" }];
}

export function mouseClickEvents(x, y, { button = "left", clickCount = 1 } = {}) {
  const mask = { left: 1, right: 2, middle: 4 }[button];
  if (!mask) throw new Error(`不认识的鼠标按键：${button}`);
  const events = [{ type: "mouseMoved", x, y, button: "none", buttons: 0 }];
  for (let n = 1; n <= clickCount; n += 1) {
    events.push({ type: "mousePressed", x, y, button, buttons: mask, clickCount: n });
    events.push({ type: "mouseReleased", x, y, button, buttons: 0, clickCount: n });
  }
  return events;
}

export function dragMoveEvents(from, to, steps = 8) {
  const events = [
    { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0 },
    { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 },
  ];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    events.push({
      type: "mouseMoved",
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
      button: "left",
      buttons: 1,
    });
  }
  events.push({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  return events;
}
