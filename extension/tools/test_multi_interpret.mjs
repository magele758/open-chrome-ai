import assert from "node:assert";
import { InterpretController, InterpretState, InterpretTask } from "../sidepanel/interpret-controller.js";

console.log("Starting Multi-Interpret Task test suite...");

// 1. Multi-task registration and state isolation
{
  const ctrl = new InterpretController();

  const task1 = new InterpretTask({ tabId: 101, sourceUrl: "https://youtube.com/watch?v=aaa", title: "Video A" });
  task1.fsmState = InterpretState.RUNNING;
  task1.details.zh = "视频A的第一句话";
  task1.originalAudioOn = false;
  ctrl.tasks.set(101, task1);

  const task2 = new InterpretTask({ tabId: 102, sourceUrl: "https://bilibili.com/video/BVbbb", title: "Video B" });
  task2.fsmState = InterpretState.RUNNING;
  task2.details.zh = "视频B的第一句话";
  task2.originalAudioOn = true;
  ctrl.tasks.set(102, task2);

  // Assert states are isolated
  assert.strictEqual(ctrl.isRunning(101), true);
  assert.strictEqual(ctrl.isRunning(102), true);
  assert.strictEqual(ctrl.isRunning(103), false);

  const state1 = ctrl.getState(101);
  assert.strictEqual(state1.zh, "视频A的第一句话");
  assert.strictEqual(state1.originalAudioOn, false);

  const state2 = ctrl.getState(102);
  assert.strictEqual(state2.zh, "视频B的第一句话");
  assert.strictEqual(state2.originalAudioOn, true);

  const running = ctrl.getRunningTasks();
  assert.strictEqual(running.length, 2);
  assert.strictEqual(running.map(r => r.tabId).sort().join(","), "101,102");
  console.log("  PASS: Multiple concurrent tasks maintain isolated states");
}

// 2. Tab switching does not terminate background tasks
{
  const ctrl = new InterpretController();
  const task1 = new InterpretTask({ tabId: 101, sourceUrl: "https://youtube.com/watch?v=aaa", title: "Video A" });
  task1.fsmState = InterpretState.RUNNING;
  ctrl.tasks.set(101, task1);

  // Active tab switches to 200 (a new tab without interpretation)
  ctrl.currentTabId = 200;
  const stateCurrent = ctrl.getState(200);
  assert.strictEqual(stateCurrent.status, "idle");
  // But task1 is still running in the background!
  assert.strictEqual(ctrl.isRunning(101), true);
  assert.strictEqual(ctrl.getRunningTasks().length, 1);
  console.log("  PASS: Switching active tab preserves background task");
}

// 3. Tab removal terminates only the closed tab's task
{
  const ctrl = new InterpretController();
  let aborted1 = false;
  let aborted2 = false;

  const task1 = new InterpretTask({ tabId: 101, sourceUrl: "https://youtube.com/watch?v=aaa", title: "Video A" });
  task1.fsmState = InterpretState.RUNNING;
  task1.abortController = { abort: () => { aborted1 = true; } };
  ctrl.tasks.set(101, task1);

  const task2 = new InterpretTask({ tabId: 102, sourceUrl: "https://bilibili.com/video/BVbbb", title: "Video B" });
  task2.fsmState = InterpretState.RUNNING;
  task2.abortController = { abort: () => { aborted2 = true; } };
  ctrl.tasks.set(102, task2);

  // Tab 101 is closed
  await ctrl.handleTabRemoved(101);
  assert.strictEqual(aborted1, true, "tab 101 should be aborted");
  assert.strictEqual(ctrl.isRunning(101), false, "tab 101 should not be running");
  assert.strictEqual(ctrl.isRunning(102), true, "tab 102 should still be running");
  assert.strictEqual(aborted2, false, "tab 102 should not be aborted");
  assert.strictEqual(ctrl.getRunningTasks().length, 1);

  // Stop remaining
  await ctrl.stop(102);
  assert.strictEqual(aborted2, true);
  assert.strictEqual(ctrl.isRunning(102), false);
  assert.strictEqual(ctrl.getRunningTasks().length, 0);
  console.log("  PASS: Tab removal terminates closed tab and keeps others running");
}

console.log("All Multi-Interpret Task tests passed successfully!");
