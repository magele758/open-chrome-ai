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
  const labels = boxes().map(label).filter(Boolean);
  if (new Set(labels).size !== labels.length) throw Error("Ambiguous category attribute controls");
  if (plan && Object.keys(plan).some(name => !labels.includes(name))) throw Error("Planned attribute control is missing");
  const result = [];
  for (const name of labels) {
    guard();
    const box = boxes().find(e => label(e) === name);
    const toggle = () => box.querySelector(".core-select-view").click();
    const options = () => [...(document.getElementById(box.getAttribute("aria-controls"))?.querySelectorAll('[role="option"]') || [])]
      .filter(e => e.getClientRects().length && e.getAttribute("aria-disabled") !== "true");
    const open = async () => {
      if (box.getAttribute("aria-expanded") !== "true") toggle();
      for (let i = 0; i < 20 && !options().length; i++) await pause(100);
      if (!options().length) throw Error("Attribute options unavailable: " + name);
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
          await pause(150);
        }
      }
      await open();
      result.push({ name, multiple: box.classList.contains("core-select-multiple"), options: options().map(e => e.innerText.trim()),
        selected: options().filter(e => e.getAttribute("aria-selected") === "true").map(e => e.innerText.trim()) });
    } finally {
      if (box?.getAttribute("aria-expanded") === "true") toggle();
    }
  }
  return result;
}

export function checkAttributes(plan, catalog) {
  if (!plan) return;
  if (catalog?.some(field => !Object.hasOwn(plan, field.name))) throw Error("Draft category attribute list changed");
  for (const [name, values] of Object.entries(plan)) {
    const field = catalog?.find(f => f.name === name);
    if (!field || !values.every(value => field.selected.includes(matchAttributeValue(field.options, value))))
      throw Error("Draft attribute differs: " + name);
  }
}

export function checkDraftAttributes(copy, state) {
  if (state.hasCategoryAttributes && !copy.attributePlan)
    throw Error("Missing saved attribute plan for this draft; reconcile its prior receipt or resave it");
  checkAttributes(copy.attributePlan?.values, state.attributeCatalog);
}
