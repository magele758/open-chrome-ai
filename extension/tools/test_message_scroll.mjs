import assert from "node:assert";
import { createMessageScroll } from "../sidepanel/message-scroll.js";

console.log("Starting message-scroll test suite...");

function createMockElement(initial = {}) {
  const listeners = {};
  const classListSet = new Set(initial.classes || []);
  const el = {
    scrollHeight: initial.scrollHeight || 1000,
    clientHeight: initial.clientHeight || 400,
    scrollTop: initial.scrollTop || 600, // at bottom initially: 1000 - 400 - 600 = 0 <= 36
    clientWidth: initial.clientWidth || 360,
    children: [],
    scrollTo: function(options) {
      if (typeof options === "object") {
        this.scrollTop = options.top;
      }
    },
    addEventListener: (event, handler) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    removeEventListener: (event, handler) => {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter(h => h !== handler);
    },
    dispatchEvent: (event) => {
      const handlers = listeners[event.type] || [];
      for (const h of handlers) h(event);
    },
    classList: {
      add: (cls) => classListSet.add(cls),
      remove: (cls) => classListSet.delete(cls),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (classListSet.has(cls)) classListSet.delete(cls);
          else classListSet.add(cls);
        } else if (force) {
          classListSet.add(cls);
        } else {
          classListSet.delete(cls);
        }
      },
      contains: (cls) => classListSet.has(cls),
    },
    querySelector: (sel) => {
      if (sel.includes("messages-bottom-dot")) {
        return createMockElement({ classes: ["hidden"] });
      }
      if (sel.includes("messages-bottom-text")) {
        return createMockElement();
      }
      return null;
    }
  };
  return el;
}

// 1. Initial State & Auto-Scroll
{
  const root = createMockElement({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
  const button = createMockElement({ classes: ["hidden"] });
  const scroll = createMessageScroll(root, button);

  assert.strictEqual(scroll.isFollowing(), true, "Should initialize following = true");
  assert.strictEqual(button.classList.contains("hidden"), true, "Button should be hidden initially when at bottom");

  // Content grows while following
  root.scrollHeight = 1200;
  scroll.onContentGrow();
  assert.strictEqual(root.scrollTop, 1200, "Should auto-scroll to bottom when following");

  scroll.destroy();
  console.log("  PASS: Initial state & auto-scroll when following");
}

// 2. User Scroll Up Breaks Following (No Conflict)
{
  const root = createMockElement({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
  const button = createMockElement({ classes: ["hidden"] });
  const scroll = createMessageScroll(root, button);

  // User wheels up
  root.dispatchEvent({ type: "wheel", deltaY: -100 });
  assert.strictEqual(scroll.isFollowing(), false, "Wheel up should immediately pause following");

  // Simulate user scroll position moved to middle
  root.scrollTop = 200; // far from bottom (1000 - 400 - 200 = 400px > 36px)
  root.dispatchEvent({ type: "scroll" });
  assert.strictEqual(scroll.isFollowing(), false, "Should stay following = false when away from bottom");
  assert.strictEqual(button.classList.contains("hidden"), false, "Button should be visible when away from bottom");

  // Streaming model chunk arrives (content grows at bottom)
  root.scrollHeight = 1400;
  scroll.onContentGrow();

  // CRUCIAL: scrollTop must NOT be changed to 1400, user reading position preserved!
  assert.strictEqual(root.scrollTop, 200, "onContentGrow must NOT change scrollTop when user is not following");
  assert.strictEqual(button.classList.contains("hidden"), false, "Button remains visible");

  scroll.destroy();
  console.log("  PASS: User scroll up breaks following without fighting streaming output");
}

// 3. Scroll to Bottom Button Restores Following
{
  const root = createMockElement({ scrollHeight: 1200, clientHeight: 400, scrollTop: 300 });
  const button = createMockElement({ classes: [] });
  const scroll = createMessageScroll(root, button);

  // User is not following
  root.dispatchEvent({ type: "wheel", deltaY: -50 });
  assert.strictEqual(scroll.isFollowing(), false);

  // User clicks the button
  button.dispatchEvent({ type: "click" });
  assert.strictEqual(scroll.isFollowing(), true, "Clicking button must set following = true");
  assert.strictEqual(root.scrollTop, 1200, "Clicking button must scroll to bottom");

  // Subsequent streaming growth should auto-scroll again
  root.scrollHeight = 1600;
  scroll.onContentGrow();
  assert.strictEqual(root.scrollTop, 1600, "Should resume auto-scroll after button click");

  scroll.destroy();
  console.log("  PASS: Scroll to bottom button restores following");
}

// 4. User Manually Scrolls Back to Bottom
{
  const root = createMockElement({ scrollHeight: 1000, clientHeight: 400, scrollTop: 200 });
  const button = createMockElement({ classes: [] });
  const scroll = createMessageScroll(root, button);

  scroll.setFollowing(false);
  assert.strictEqual(scroll.isFollowing(), false);

  // User scrolls back down near bottom
  root.scrollTop = 580; // distance: 1000 - 400 - 580 = 20px <= 36px threshold
  root.dispatchEvent({ type: "scroll" });
  assert.strictEqual(scroll.isFollowing(), true, "Reaching bottom naturally resumes following");
  assert.strictEqual(button.classList.contains("hidden"), true, "Button hides when reaching bottom");

  scroll.destroy();
  console.log("  PASS: User manually scrolling to bottom resumes following");
}

// 5. Full Re-render (renderMessages) preserves position when not following
{
  const root = createMockElement({ scrollHeight: 1000, clientHeight: 400, scrollTop: 250 });
  const button = createMockElement({ classes: [] });
  const scroll = createMessageScroll(root, button);

  scroll.setFollowing(false);

  const savedTop = scroll.beforeRender();
  assert.strictEqual(savedTop, 250);

  // Simulate innerHTML = "" resetting scrollTop to 0
  root.scrollTop = 0;
  root.scrollHeight = 1100;

  scroll.afterRender(savedTop);
  assert.strictEqual(root.scrollTop, 250, "afterRender must restore savedTop when not following");

  scroll.destroy();
  console.log("  PASS: Full re-render preserves scroll position when not following");
}

// 6. Reset Forces Bottom Following
{
  const root = createMockElement({ scrollHeight: 1500, clientHeight: 400, scrollTop: 200 });
  const button = createMockElement({ classes: [] });
  const scroll = createMessageScroll(root, button);

  scroll.setFollowing(false);
  scroll.reset();

  assert.strictEqual(scroll.isFollowing(), true, "reset() must set following = true");
  assert.strictEqual(root.scrollTop, 1500, "reset() must scroll to bottom");

  scroll.destroy();
  console.log("  PASS: reset() re-pins to bottom");
}

console.log("All message-scroll tests passed successfully!");
