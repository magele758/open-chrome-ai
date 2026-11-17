import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { observeCoverage } from './coverage.js';
import { settingsFixture } from './settings-fixture.mjs';

export const scenarios = ['settings', 'panel', 'graph'];
const sidepanel = new URL('../../extension/sidepanel/', import.meta.url);

export async function browserFixture(name) {
  if (name === 'settings') return settingsFixture();
  if (!scenarios.includes(name)) throw Error('Unknown scenario: ' + name);
  const graph = name === 'graph';
  const dom = new JSDOM(await readFile(new URL(graph ? 'graph.html' : 'index.html', sidepanel), 'utf8'));
  const { document } = dom.window;
  for (const node of document.querySelectorAll('script, link')) node.remove();
  const styles = graph ? ['graph'] : ['styles', 'dub-queue', 'themes', 'sidechat', 'settings'];
  for (const file of styles) {
    const style = document.createElement('style');
    style.textContent = await readFile(new URL(file + '.css', sidepanel), 'utf8');
    document.head.append(style);
  }
  const entry = graph ? 'graph.js' : 'app.js';
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(sidepanel), contents:
      `import '../../scripts/bombadil/host-fixture.js'; import './${entry}';` },
    define: { 'import.meta.url': 'location.href' },
    external: ['../vendor/pdfjs/pdf.min.mjs'], bundle: true, write: false, format: 'iife', target: 'es2022',
  });
  const script = document.createElement('script');
  script.textContent = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  document.body.append(script);
  const html = dom.serialize();
  dom.window.close();
  return html;
}

export async function instrumentedFixture(name) {
  const html = await browserFixture(name);
  const observer = '<script>(' + observeCoverage.toString() + ')(' + JSON.stringify(name) + ')</script>';
  return html.replace(/<\/body>\s*<\/html>\s*$/i, () => observer + '</body></html>');
}
