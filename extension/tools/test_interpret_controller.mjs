import assert from "node:assert";
import { InterpretController, InterpretState } from "../sidepanel/interpret-controller.js";

console.log("Starting InterpretController test suite...");

// 1. Initial State
{
  const ctrl = new InterpretController();
  assert.strictEqual(ctrl.fsmState, InterpretState.IDLE);
  assert.strictEqual(ctrl.isRunning(), false);
  const st = ctrl.getState();
  assert.strictEqual(st.status, "idle");
  assert.strictEqual(st.originalAudioOn, true);
  console.log("  PASS: Initial state is IDLE");
}

// 2. State subscriber and stop
{
  const ctrl = new InterpretController();
  const events = [];
  const unsub = ctrl.subscribe((ev, st) => {
    events.push({ type: ev.type, status: st.status });
  });

  await ctrl.stop();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, "stopped");
  assert.strictEqual(ctrl.isRunning(), false);

  unsub();
  await ctrl.stop();
  assert.strictEqual(events.length, 1, "unsubscribed listener should not receive events");
  console.log("  PASS: Subscription and stop lifecycle");
}

// 3. Audio toggle error handling when no tab
{
  const ctrl = new InterpretController();
  const res = await ctrl.toggleOriginalAudio(null);
  assert.strictEqual(res, true, "no tab leaves audio on");
  console.log("  PASS: Safe toggle when tabId is missing");
}

console.log("All InterpretController tests passed successfully!");
