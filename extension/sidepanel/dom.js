const $ = (id) => document.getElementById(id);

function on(id, event, handler) {
  const el = $(id);
  if (!el) {
    console.warn("[pagelens] wire missing", id);
    return null;
  }
  el.addEventListener(event, handler);
  return el;
}


export {
  $,
  on,
};
