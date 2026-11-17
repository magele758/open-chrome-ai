import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { instrumentedFixture, scenarios } from './browser-fixture.mjs';
import { requiredVisits } from './coverage.js';

const { values: args } = parseArgs({ options: {
  case: { type: 'string' }, width: { type: 'string' }, time: { type: 'string', default: '45s' },
  output: { type: 'string' }, replay: { type: 'string' },
} });
const selected = args.case ? [args.case] : scenarios;
if (!selected.every(name => scenarios.includes(name))) throw Error('Expected --case settings, panel or graph');
if (!/^[1-9]\d*[smh]$/.test(args.time)) throw Error('Expected a time limit such as 45s or 5m');
if (args.width && !/^[1-9]\d{1,3}$/.test(args.width)) throw Error('Invalid viewport width');
const root = resolve(args.output || tmpdir());
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'pagelens-bombadil-'));
console.log('Run artifacts:', directory);
const version = spawnSync('bombadil', ['--version'], { encoding: 'utf8' });
if (version.status !== 0) {
  console.error(version.error?.code === 'ENOENT'
    ? 'Bombadil CLI missing. See docs/bombadil-testing.md for the pinned npm exec command.'
    : version.error?.message || version.stderr || 'Cannot start Bombadil');
  process.exit(1);
}
const replay = args.replay && resolve(args.replay);
if (replay && (args.case || args.width)) throw Error('Replay uses the recorded case and width');
const cases = replay ? [JSON.parse(await readFile(join(replay, 'run.json'), 'utf8'))] :
  selected.flatMap(name => (args.width ? [Number(args.width)] : name === 'panel' ? [400, 900] :
    [name === 'graph' ? 900 : 400]).map(width => ({ name, width })));

for (const item of cases) {
  const { name, width } = item;
  if (!scenarios.includes(name) || !Number.isInteger(width)) throw Error('Invalid replay metadata');
  const out = join(directory, name + '-' + width);
  await mkdir(out);
  const fixture = replay ? await readFile(join(replay, 'fixture.html'), 'utf8') :
    await instrumentedFixture(name);
  await writeFile(join(out, 'fixture.html'), fixture);
  const spec = join(out, 'spec.js');
  if (replay) {
    await writeFile(spec, await readFile(join(replay, 'spec.js')));
  } else {
    await build({
      entryPoints: [fileURLToPath(new URL(name + '.spec.js', import.meta.url))], outfile: spec,
      format: 'esm', bundle: true, platform: 'neutral', packages: 'external',
    });
  }
  const visits = new Set();
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/' + name) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(fixture);
    } else if (req.method === 'POST' && /^\/observed\/[a-z-]+$/.test(req.url)) {
      visits.add(req.url.slice('/observed/'.length));
      res.writeHead(204).end();
    } else res.writeHead(404).end();
  });
  await new Promise((ok, fail) => server.once('error', fail).listen(replay ? item.port : 0, '127.0.0.1', ok));
  try {
    const port = server.address().port;
    const origin = 'http://127.0.0.1:' + port + '/' + name;
    const trace = join(out, 'trace');
    const flags = ['browser', 'test', '--headless', '--width', String(width), '--output-path', trace];
    if (process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.platform === 'linux') flags.push('--no-sandbox');
    if (replay) flags.push('--reproduce', join(replay, 'trace'));
    else flags.push('--exit-on-violation', '--time-limit', args.time);
    const chromeVersion = process.env.CHROME && spawnSync(process.env.CHROME, ['--version'], { encoding: 'utf8' }).stdout?.trim();
    const metadata = { name, width, port, origin, version: version.stdout.trim(), chromeVersion, timeLimit: replay ? null : args.time,
      commit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() };
    await writeFile(join(out, 'run.json'), JSON.stringify(metadata, null, 2));
    const start = Date.now();
    const code = await new Promise((ok, fail) => {
      const child = spawn('bombadil', [...flags, origin, spec], { stdio: 'inherit' });
      child.once('error', fail);
      child.once('close', status => ok(status ?? 1));
    });
    const missing = requiredVisits[name].filter(v => !visits.has(v));
    const traceExists = (await stat(join(trace, 'trace.jsonl')).catch(() => null))?.size > 0;
    const status = code === 2 ? 'violation' : code ? 'runner-error' : !traceExists ? 'missing-trace' :
      !replay && missing.length ? 'insufficient-coverage' : 'passed';
    const report = { status, code, elapsedMs: Date.now() - start, visited: [...visits], missing, traceExists };
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(name, width, JSON.stringify(report), out);
    if (status !== 'passed') process.exitCode ||= code || 1;
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
}
