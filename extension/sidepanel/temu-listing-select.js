// The panel uses disclosure buttons with searchable lists of native buttons.
export function bindTemuListingSelect(container, { label, placeholder, search, onOpen }) {
  const trigger = container.querySelector("button");
  const menu = container.querySelector(".temu-select-menu");
  const choices = container.querySelector(".temu-select-options");
  const value = trigger.querySelector("span");
  const query = menu.querySelector("input");
  let selected = "";

  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", menu.id);
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", label);

  function setValue(text, key = text) {
    selected = key;
    value.textContent = text || placeholder;
    value.classList.toggle("temu-select-placeholder", !text);
    trigger.title = text;
    for (const row of choices.querySelectorAll("button")) {
      row.setAttribute("aria-pressed", String(Boolean(selected) && selected === row.dataset.key));
    }
  }

  function close(focus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (focus) trigger.focus();
  }

  function render(rows, fallback = "没有匹配选项。") {
    choices.replaceChildren();
    if (!rows.length) {
      const message = document.createElement("p");
      message.className = "temu-select-empty";
      message.textContent = fallback;
      choices.append(message);
      return;
    }
    choices.append(...rows.map(({ key, label, branch, disabled, pick }) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "temu-select-option";
      row.dataset.key = key;
      row.disabled = Boolean(disabled);
      if (!branch) row.setAttribute("aria-pressed", String(Boolean(selected) && selected === key));
      const name = document.createElement("span");
      name.textContent = label;
      row.append(name);
      if (branch) {
        const chevron = document.createElement("span");
        chevron.className = "temu-select-next";
        chevron.setAttribute("aria-hidden", "true");
        row.append(chevron);
      }
      row.addEventListener("click", () => {
        if (branch) query?.focus();
        else close(true);
        pick();
      });
      return row;
    }));
  }

  function show() {
    if (trigger.disabled) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    if (query) query.value = "";
    onOpen?.();
    if (query) query.focus();
    else choices.querySelector('button[aria-pressed="true"]:not(:disabled), button:not(:disabled)')?.focus();
    menu.scrollIntoView?.({ block: "nearest" });
  }

  trigger.addEventListener("click", () => menu.hidden ? show() : close());
  query?.addEventListener("input", () => search?.(query.value.trim()));
  container.addEventListener("keydown", event => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (menu.hidden) return show();
      const rows = [...choices.querySelectorAll("button:not(:disabled)")];
      const current = rows.indexOf(document.activeElement);
      const next = event.key === "ArrowDown" ? (current + 1) % rows.length : (current <= 0 ? rows.length - 1 : current - 1);
      rows[next]?.focus();
    }
  });

  container.addEventListener("focusout", event => {
    if (event.relatedTarget && !container.contains(event.relatedTarget)) close();
  });
  container.closest("dialog").addEventListener("pointerdown", event => {
    if (!container.contains(event.target)) close();
  });
  setValue("");
  return { close, render, setValue, setDisabled: disabled => { trigger.disabled = disabled; }, isOpen: () => !menu.hidden };
}
