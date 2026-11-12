import assert from 'node:assert/strict';
import {
  debugLog,
  debugId,
  exportDebugLog,
  configureDebugLog,
  resetDebugLogForTests,
  DEBUG_LIMIT,
  DEBUG_LIMIT_L0,
} from '../lib/debug-log.js';

const original = console.info;
const printed = [];
console.info = (...args) => printed.push(args);
try {
  resetDebugLogForTests();
  assert.notEqual(debugId('test'), debugId('test'));

  // 1. 默认 L0 (minimal)：静默内存环形缓冲，不刷 console.info，仍严格脱敏
  debugLog('l0.test', { apiKey: 'l0-secret', url: 'https://example.test/page?token=abc#hash' });
  assert.equal(printed.length, 0, 'L0 minimal mode does not spam console.info');
  const l0Saved = JSON.parse(exportDebugLog());
  assert.equal(l0Saved.limit, DEBUG_LIMIT_L0);
  assert.ok(!JSON.stringify(l0Saved).includes('l0-secret') && !JSON.stringify(l0Saved).includes('token=abc'));

  // 2. 开启 L2 (full)：扩容至 DEBUG_LIMIT(4000) 并开启 console.info 镜像与完整诊断能力
  resetDebugLogForTests();
  configureDebugLog({ enabled: true, traceLevel: 'full' });

  debugLog('test', { apiKey: 'secret1', authorization: 'secret2', blob: 'audio-bytes',
    url: 'https://user:password@example.test/video?token=secret3#secret4',
    error: new Error('secret5'), nested: { headers: { Authorization: 'secret6' } },
    text: '优优独播剧场——', auth: 'Bearer secret7' });
  const saved = exportDebugLog();
  for (const token of ['secret1','secret2','secret3','secret4','secret5','secret6','secret7','audio-bytes','user:password']) assert(!saved.includes(token), token);
  assert(saved.includes('优优独播剧场'), 'keep diagnostic ASR text');
  debugLog('agent.tool.start', { name: 'update_settings', args: { changes: [{ key: 'asr.apiKey', value: 'secret8' }, { key: 'uiTheme', value: 'cyber' }] } });
  const settingsLog = exportDebugLog();
  assert(!settingsLog.includes('secret8'), 'key/value pairs naming a secret are redacted');
  assert(settingsLog.includes('cyber') && settingsLog.includes('asr.apiKey'), 'non-secret settings stay readable');
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
} finally {
  resetDebugLogForTests();
  console.info = original;
}
console.log('PASS debug logs: L0 silent default + L2 console/export, IDs, redaction, retention limits, failure isolation');
