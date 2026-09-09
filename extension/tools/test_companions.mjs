import { automaExecute, probeCompanions } from "../lib/agent/companions.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const events = [];
globalThis.CustomEvent = class {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};
globalThis.dispatchEvent = (ev) => {
  events.push(ev.type);
  return true;
};
globalThis.isAutomaInjected = false;
globalThis.$cose = null;

assert(probeCompanions().automa === false && probeCompanions().cose === false, "empty probe");
assert(automaExecute({ publicId: "x" }).ok === false, "automa missing");

globalThis.isAutomaInjected = true;
const ran = automaExecute({ publicId: "wf-1", data: { q: 1 } });
assert(ran.ok && ran.id === "wf-1", "automa dispatch");
assert(events.includes("automa:execute-workflow"), "event name");

console.log("PASS companions");
