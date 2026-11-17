// Runs inside the tested page, including when Bombadil serializes the extractor.
export function readSettingsState({ document }) {
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const panels = [...document.querySelectorAll('[role=tabpanel]')];
  const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true');
  const visible = panels.filter(panel => !panel.hidden && document.defaultView.getComputedStyle(panel).display !== 'none');
  const current = selected[0];
  const focusedTab = document.activeElement?.closest('[role=tab]');
  return {
    selected: current?.dataset.settingsTab ?? null,
    tabAndPanelAgree: tabs.length === 2 && panels.length === 2 &&
      selected.length === 1 && visible.length === 1 &&
      visible[0].id === current.getAttribute('aria-controls') &&
      visible[0].getAttribute('aria-labelledby') === current.id,
    keyboardAccess: selected.length === 1 && tabs.every(tab => tab.tabIndex === (tab === current ? 0 : -1)) &&
      (!focusedTab || focusedTab === current),
    focusedTab: focusedTab?.dataset.settingsTab ?? null,
    draft: document.getElementById('jev-model')?.value ?? null,
  };
}
