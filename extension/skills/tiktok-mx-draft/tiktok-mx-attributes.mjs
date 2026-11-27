import { sellerVerification } from "./tiktok-mx-list.mjs";

// The seller may translate one half of a bilingual label after reload. Match
// a whole language label only when it identifies one option in this menu.
export function matchAttributeValue(options, expected) {
  const aliases = expected.split("\n").map(s => s.trim()).filter(Boolean);
  const exact = options.filter(s => s === expected);
  const matches = exact.length ? exact : options.filter(s => s.split("\n").some(part => aliases.includes(part.trim())));
  return matches.length === 1 ? matches[0] : null;
}

// Serialized into an identified seller tab. Opening a menu reads its offered and
// checked options. Only an explicit plan may select an option.
export async function sellerAttributes(expectedUrl, plan = null) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const guard = () => {
    if (location.href !== expectedUrl || sellerVerification()) throw Error("Draft changed or seller verification is open");
  };
  const boxes = () => [...document.querySelectorAll('[role="combobox"][aria-haspopup="listbox"]')]
    .filter(box => box.getClientRects().length && !box.closest('[data-id],table,[role="row"]'));
  const label = box => box.parentElement?.parentElement?.parentElement?.parentElement?.innerText.split("\n")[0].trim();
  const visible = element => Boolean(element?.isConnected && element.getClientRects().length &&
    (element.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true));
  const labels = boxes().map(label).filter(Boolean);
  if (new Set(labels).size !== labels.length) throw Error("Ambiguous category attribute controls");
  if (plan && Object.keys(plan).some(name => !labels.includes(name))) throw Error("Planned attribute control is missing");
  const result = [];
  for (const name of labels) {
    guard();
    const box = () => boxes().find(e => label(e) === name);
    const expanded = () => box()?.getAttribute("aria-expanded") === "true";
    const toggle = () => {
      guard();
      const view = box()?.querySelector(".core-select-view");
      if (!view) throw Error("Category attribute control changed: " + name);
      view.click();
    };
    const ownedPortals = new Set();
    const portal = () => {
      const id = box()?.getAttribute("aria-controls");
      const menu = id ? document.getElementById(id) : null;
      if (menu) ownedPortals.add(menu);
      return menu;
    };
    // In background tabs, an open menu can expose options before its fade-in progresses.
    const options = () => [...(portal()?.querySelectorAll('[role="option"]') || [])]
      .filter(e => e.getClientRects().length && e.getAttribute("aria-disabled") !== "true");
    const wait = async (ready, error) => {
      for (let i = 0; i < 50 && !ready(); i++) await pause(40);
      if (!ready()) throw Error(error + name);
    };
    const waitForClosed = () => wait(() => {
      // A re-render can replace the control while the previous portal is still animating.
      portal();
      return !expanded() && ![...ownedPortals].some(visible);
    }, "Attribute menu did not close: ");
    const open = async () => {
      if (!expanded()) {
        await waitForClosed();
        toggle();
      }
      await wait(() => expanded() && options().length, "Attribute options unavailable: ");
    };
    try {
      await open();
      for (const value of plan?.[name] || []) {
        guard();
        await open();
        const label = matchAttributeValue(options().map(e => e.innerText.trim()), value);
        const matches = options().filter(e => e.innerText.trim() === label);
        if (matches.length !== 1) throw Error("Attribute option changed: " + name);
        if (matches[0].getAttribute("aria-selected") !== "true") {
          matches[0].click();
          await pause(60);
        }
      }
      await open();
      if (!plan && box()?.classList.contains("core-select-multiple") && box()?.querySelector(".core-tag")) {
        for (let i = 0; i < 12 && !options().some(e => e.getAttribute("aria-selected") === "true"); i++) await pause(50);
      }
      const choices = options();
      result.push({ name, multiple: box().classList.contains("core-select-multiple"), options: choices.map(e => e.innerText.trim()),
        selected: choices.filter(e => e.getAttribute("aria-selected") === "true").map(e => e.innerText.trim()) });
    } finally {
      portal();
      if (expanded()) {
        guard();
        const input = box()?.querySelector('input:not([type="hidden"]):not(:disabled)');
        if (input) {
          // The trigger can leave a searchable multi-select open. Escape is handled by its input.
          input.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true,
          }));
          if (expanded()) await pause(100);
        }
        if (expanded()) toggle();
      }
      await waitForClosed();
    }
  }
  return result;
}

export function checkAttributes(plan, catalog, { exact = false } = {}) {
  if (!plan) return;
  if (catalog?.some(field => !Object.hasOwn(plan, field.name))) throw Error("Draft category attribute list changed");
  for (const [name, values] of Object.entries(plan)) {
    const field = catalog?.find(f => f.name === name);
    if (!field || !values.every(value => field.selected.includes(matchAttributeValue(field.options, value))) ||
        (exact && values.length > 0 && field.selected.length !== values.length))
      throw Error("Draft attribute differs: " + name);
  }
}

export function checkDraftAttributes(copy, state, options) {
  if (state.hasCategoryAttributes && !copy.attributePlan)
    throw Error("Missing saved attribute plan for this draft; reconcile its prior receipt or resave it");
  checkAttributes(copy.attributePlan?.values, state.attributeCatalog, options);
}
