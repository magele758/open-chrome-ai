(() => {
  if (document.documentElement.dataset.tooltipsBound) return;
  document.documentElement.dataset.tooltipsBound = "1";

  const tip = document.createElement("div");
  tip.className = "app-tooltip";
  tip.hidden = true;
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);

  const GAP = 6;
  let active = null;

  function hide() {
    active = null;
    tip.hidden = true;
    tip.textContent = "";
    tip.style.left = "0px";
    tip.style.top = "0px";
  }

  function triggerFrom(node) {
    return node?.closest?.("[data-tooltip]");
  }

  function place(el) {
    const text = (el.getAttribute("data-tooltip") || "").trim();
    if (!text) {
      hide();
      return;
    }
    active = el;
    tip.textContent = text;
    tip.hidden = false;
    const rect = el.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let top = rect.bottom + GAP;
    if (top + height > window.innerHeight - 4) top = Math.max(4, rect.top - height - GAP);
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.min(window.innerWidth - width - 4, Math.max(4, left));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.transform = "none";
  }

  document.addEventListener("pointerover", (event) => {
    const el = triggerFrom(event.target);
    if (el) place(el);
  });
  document.addEventListener("pointerout", (event) => {
    const el = triggerFrom(event.target);
    if (!el || el.contains(event.relatedTarget)) return;
    if (triggerFrom(event.relatedTarget) === el) return;
    hide();
  });
  document.addEventListener("focusin", (event) => {
    const el = triggerFrom(event.target);
    if (el) place(el);
  });
  document.addEventListener("focusout", (event) => {
    if (!triggerFrom(event.relatedTarget)) hide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  document.addEventListener("scroll", hide, true);
})();
