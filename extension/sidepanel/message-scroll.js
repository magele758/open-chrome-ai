// Session message list scroll controller
// Prevents streaming model output from conflicting with user scrolling gestures,
// and provides a fast "scroll to bottom" button with new message alerts.

const DEFAULT_BOTTOM_THRESHOLD = 36;
const USER_INTERACTION_TIMEOUT_MS = 350;

export function createMessageScroll(root, button, options = {}) {
  const bottomThreshold = options.bottomThreshold ?? DEFAULT_BOTTOM_THRESHOLD;

  let following = true;
  let hasNewContent = false;
  let isProgrammaticScrolling = false;
  let lastUserInteractionTime = 0;

  const btnDot = button?.querySelector(".messages-bottom-dot");
  const btnText = button?.querySelector(".messages-bottom-text");

  const raf = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 16);

  function isAtBottom(threshold = bottomThreshold) {
    if (!root) return true;
    const distance = root.scrollHeight - root.clientHeight - root.scrollTop;
    return distance <= threshold;
  }

  function markUserInteracting() {
    lastUserInteractionTime = Date.now();
  }

  function isUserInteracting() {
    return Date.now() - lastUserInteractionTime < USER_INTERACTION_TIMEOUT_MS;
  }

  function updateButton() {
    if (!button) return;
    const atBot = isAtBottom();
    if (atBot) {
      button.classList.add("hidden");
      if (btnDot) btnDot.classList.add("hidden");
      hasNewContent = false;
    } else {
      button.classList.remove("hidden");
      if (btnDot) {
        btnDot.classList.toggle("hidden", !hasNewContent);
      }
    }
  }

  function scrollToBottom({ smooth = false } = {}) {
    if (!root) return;
    isProgrammaticScrolling = true;
    if (smooth && typeof root.scrollTo === "function") {
      root.scrollTo({ top: root.scrollHeight, behavior: "smooth" });
    } else {
      root.scrollTop = root.scrollHeight;
    }

    raf(() => {
      isProgrammaticScrolling = false;
      updateButton();
    });
  }

  function onContentGrow() {
    if (following) {
      scrollToBottom({ smooth: false });
    } else {
      hasNewContent = true;
      updateButton();
    }
  }

  function beforeRender() {
    return root ? root.scrollTop : 0;
  }

  function afterRender(savedTop) {
    if (following) {
      scrollToBottom({ smooth: false });
    } else if (savedTop !== undefined && root) {
      isProgrammaticScrolling = true;
      root.scrollTop = savedTop;
      raf(() => {
        isProgrammaticScrolling = false;
        updateButton();
      });
    } else {
      updateButton();
    }
  }

  function reset() {
    following = true;
    hasNewContent = false;
    lastUserInteractionTime = 0;
    scrollToBottom({ smooth: false });
  }

  // --- User Gesture Event Handlers ---
  const onWheel = (event) => {
    markUserInteracting();
    // Scrolling up leaves bottom immediately; scrolling down while not at bottom also keeps following paused
    if (event.deltaY < 0 || !isAtBottom()) {
      following = false;
    }
    updateButton();
  };

  const onTouchStart = () => {
    markUserInteracting();
  };

  const onTouchMove = () => {
    markUserInteracting();
    if (!isAtBottom()) {
      following = false;
    }
    updateButton();
  };

  const onPointerDown = (event) => {
    markUserInteracting();
    // Clicks on scrollbar track or thumb, or general interaction when away from bottom
    const isNearScrollbar = root && (event.offsetX >= root.clientWidth - 20);
    if (isNearScrollbar || !isAtBottom()) {
      following = false;
    }
    updateButton();
  };

  const onKeyDown = (event) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
      markUserInteracting();
      following = false;
      updateButton();
    } else if (event.key === "End") {
      following = true;
      hasNewContent = false;
      lastUserInteractionTime = 0;
      scrollToBottom({ smooth: true });
    }
  };

  const onScroll = () => {
    if (isProgrammaticScrolling) return;

    if (isAtBottom()) {
      following = true;
      hasNewContent = false;
    } else {
      following = false;
    }
    updateButton();
  };

  const onButtonClick = () => {
    following = true;
    hasNewContent = false;
    lastUserInteractionTime = 0;
    scrollToBottom({ smooth: true });
  };

  if (root) {
    root.addEventListener("wheel", onWheel, { passive: true });
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: true });
    root.addEventListener("pointerdown", onPointerDown, { passive: true });
    root.addEventListener("keydown", onKeyDown);
    root.addEventListener("scroll", onScroll, { passive: true });
  }

  if (button) {
    button.addEventListener("click", onButtonClick);
  }

  let resizeObserver = null;
  if (typeof ResizeObserver !== "undefined" && root) {
    resizeObserver = new ResizeObserver(() => {
      if (following && !isUserInteracting()) {
        scrollToBottom({ smooth: false });
      } else {
        updateButton();
      }
    });
    resizeObserver.observe(root);
  }

  updateButton();

  return {
    beforeRender,
    afterRender,
    onContentGrow,
    reset,
    scrollToBottom,
    isFollowing: () => following,
    setFollowing: (val) => { following = Boolean(val); updateButton(); },
    isAtBottom,
    updateButton,
    destroy() {
      if (root) {
        root.removeEventListener("wheel", onWheel);
        root.removeEventListener("touchstart", onTouchStart);
        root.removeEventListener("touchmove", onTouchMove);
        root.removeEventListener("pointerdown", onPointerDown);
        root.removeEventListener("keydown", onKeyDown);
        root.removeEventListener("scroll", onScroll);
      }
      if (button) {
        button.removeEventListener("click", onButtonClick);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    },
  };
}
