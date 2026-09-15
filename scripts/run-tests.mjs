#!/usr/bin/env node
/**
 * Unified test runner for PageLens extension.
 * Usage:
 *   node scripts/run-tests.mjs          # run all tests
 *   node scripts/run-tests.mjs --quick  # skip known slow tests
 *   node scripts/run-tests.mjs test_dub # filter by name substring
 */
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dir = resolve(__dirname, '../extension/tools');
const files = readdirSync(dir)
  .filter(f => f.startsWith('test_') && f.endsWith('.mjs'))
  .sort();

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const filters = args.filter(a => !a.startsWith('--'));

// Tests that take >5s — skipped in --quick mode
const SLOW = new Set([
  'test_planned_interpret',
  'test_streaming_audio',
  'test_full_audio_generation',
  'test_pure_audio_isolation',
  'test_subtitle_voices',
]);

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const start = Date.now();

for (const file of files) {
  const name = basename(file, '.mjs');

  // Filter by name substring if arguments given
  if (filters.length && !filters.some(f => name.includes(f))) {
    continue;
  }

  if (quick && SLOW.has(name)) {
    skipped++;
    console.log(`  \x1b[33mSKIP\x1b[0m  ${name}`);
    continue;
  }

  process.stdout.write(`  RUN   ${name} ... `);
  const t0 = Date.now();
  try {
    execFileSync('node', [resolve(dir, file)], {
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ms = Date.now() - t0;
    passed++;
    console.log(`\x1b[32mPASS\x1b[0m ${ms > 2000 ? `(${(ms / 1000).toFixed(1)}s)` : ''}`);
  } catch (err) {
    failed++;
    const stderr = err.stderr?.toString().slice(-800) || '';
    failures.push({ name, stderr });
    console.log(`\x1b[31mFAIL\x1b[0m`);
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n${'─'.repeat(55)}`);
const summary = [];
if (passed) summary.push(`\x1b[32m${passed} passed\x1b[0m`);
if (failed) summary.push(`\x1b[31m${failed} failed\x1b[0m`);
if (skipped) summary.push(`\x1b[33m${skipped} skipped\x1b[0m`);
console.log(`  ${summary.join(', ')}  (${elapsed}s)`);

if (failures.length) {
  console.log('\n\x1b[31mFailures:\x1b[0m');
  for (const f of failures) {
    console.log(`\n  ✗ ${f.name}`);
    const lines = f.stderr.split('\n').filter(Boolean).slice(-8);
    for (const l of lines) console.log(`    ${l}`);
  }
  process.exit(1);
}
