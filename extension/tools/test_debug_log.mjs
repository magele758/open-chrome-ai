import assert from 'node:assert/strict';
import { debugLog, debugId, exportDebugLog, DEBUG_LIMIT } from '../lib/debug-log.js';
const original = console.info;
const printed = [];
console.info = (...args) => printed.push(args);
try {
  assert.notEqual(debugId('test'), debugId('test'));
  debugLog('test', { apiKey: 'secret1', authorization: 'secret2', blob: 'audio-bytes',
    url: 'https://user:password@example.test/video?token=secret3#secret4',
    error: new Error('secret5'), nested: { headers: { Authorization: 'secret6' } },
    text: '优优独播剧场——', auth: 'Bearer secret7' });
  const saved = exportDebugLog();
  for (const token of ['secret1','secret2','secret3','secret4','secret5','secret6','secret7','audio-bytes','user:password']) assert(!saved.includes(token), token);
  assert(saved.includes('优优独播剧场'), 'keep diagnostic ASR text');
  assert.equal(printed[0][0], '[PageLens debug]');
  assert.equal(JSON.parse(printed[0][1]).event, 'test');
  for (let i = 0; i < DEBUG_LIMIT + 20; i++) debugLog('translation.raw', { i, text: 'x'.repeat(5000) });
  debugLog('agent.tool', { name: 'run_shell', command: 'ls /tmp' });
  const log = JSON.parse(exportDebugLog());
  assert.equal(log.entries.length, DEBUG_LIMIT);
  assert.ok(log.counts, 'export includes event counts');
  assert.ok(log.entries.some((e) => e.event === 'agent.tool'), 'prefer keeping agent events over media flood');
  assert(log.entries.find((e) => e.event === 'translation.raw').text.length < 4050);
  console.info = () => { throw new Error('broken console'); };
  assert.doesNotThrow(() => debugLog('still-safe'));
} finally { console.info = original; }
console.log('PASS debug logs: console/export, IDs, redaction, retention limits, failure isolation');
