import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const sidepanel = new URL('../../extension/sidepanel/', import.meta.url);

export async function settingsFixture() {
  const html = await readFile(new URL('index.html', sidepanel), 'utf8');
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const root = document.getElementById('view-settings');
  document.body.replaceChildren(root);
  root.classList.remove('hidden');
  document.head.querySelectorAll('link').forEach(link => link.remove());
  const style = document.createElement('style');
  style.textContent = await readFile(new URL('settings.css', sidepanel), 'utf8');
  document.head.append(style);

  const bundle = await build({
    stdin: {
      contents: `
        import { createSettingsPage } from './settings-page.js';
        import { defaultSettings } from '../lib/storage.js';
        const settings = defaultSettings();
        const root = document.getElementById('view-settings');
        createSettingsPage({ root, getSettings: () => settings, onModelChange() {} });
        const draft = root.querySelector('#jev-model');
        draft.value = 'unsaved-model';
        draft.dispatchEvent(new Event('input', { bubbles: true }));
      `,
      resolveDir: fileURLToPath(sidepanel),
    },
    bundle: true, format: 'iife', write: false,
  });
  const script = document.createElement('script');
  script.textContent = bundle.outputFiles[0].text;
  document.body.append(script);
  const result = dom.serialize();
  dom.window.close();
  return result;
}
