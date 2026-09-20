// Keyed by trace item rather than tool name: repeated calls remain independent.
const expanded = new WeakMap();
export function toolCardOpen(item) {
  return expanded.get(item) ?? false;
}
export function bindToolCardState(details, item) {
  details.querySelector('summary').addEventListener('click', () => {
    // Record synchronously before the next streamed render can replace the node.
    expanded.set(item, !details.open);
  });
  details.addEventListener('toggle', () => {
    if (details.isConnected) expanded.set(item, details.open);
  });
}
