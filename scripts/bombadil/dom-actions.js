import { registerCustomAction } from '@antithesishq/bombadil/browser';

export const choose = registerCustomAction('chooseControl', async (document, _window, selector, index) => {
  const control = document.querySelectorAll(selector)[index];
  if (!control || control.disabled || control.closest('.hidden,[hidden]')) throw Error('Unavailable control: ' + selector);
  control.focus();
  control.click();
});

export const enter = registerCustomAction('changeField', async (document, window, id, value) => {
  const el = document.getElementById(id);
  if (!el || el.disabled || el.closest('.hidden,[hidden]')) throw Error('Unavailable field: ' + id);
  el.value = value;
  el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
