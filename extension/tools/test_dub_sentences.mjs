import assert from 'node:assert/strict';
import { groupSentences, restoreSentenceBreaks, budgetChars, splitZhProportional, sentenceUnitsFromRestore, resolveSentenceEdit, endsSentence, hanCount } from '../lib/dub-sentences.js';
import { buildTranslationInput } from '../lib/interpret-context.js';

const cue = (id, start, end, src, speaker, extra = {}) => ({ id, start, end, src, speaker, ...extra });

const merged = groupSentences([
  cue('1', 0, 1.2, 'Hello', 'A'),
  cue('2', 1.4, 2.4, 'there', 'A'),
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].id, '1+2');
assert.deepEqual(merged[0].sourceIds, ['1', '2']);
assert.equal(merged[0].src, 'Hello there');
assert.equal(merged[0].start, 0);
assert.equal(merged[0].end, 2.4);
assert.equal(merged[0].speaker, 'A');
assert.equal(merged[0].overlap, false);

const stopped = groupSentences([
  cue('1', 0, 1, 'Hello.', 'A'),
  cue('2', 1.1, 2, 'World', 'A'),
]);
assert.equal(stopped.length, 2);
assert.deepEqual(stopped.map(item => item.id), ['1', '2']);

const speakers = groupSentences([
  cue('1', 0, 1, 'Hello', 'A'),
  cue('2', 1.1, 2, 'there', 'B'),
]);
assert.equal(speakers.length, 2);

const overlap = groupSentences([
  cue('1', 0, 1, 'Hello', 'A', { overlap: true }),
  cue('2', 1.1, 2, 'there', 'A'),
  cue('3', 3, 4, 'Wait', 'A'),
  cue('4', 4.1, 5, 'please', 'A', { overlap: true }),
]);
assert.deepEqual(overlap.map(item => item.id), ['1', '2', '3', '4']);
assert.equal(overlap[0].overlap, true);
assert.equal(overlap[3].overlap, true);

const gap = groupSentences([
  cue('1', 0, 1, 'Hello', 'A'),
  cue('2', 1.36, 2, 'there', 'A'),
]);
assert.equal(gap.length, 2);
const tight = groupSentences([
  cue('1', 0, 1, 'Hello', 'A'),
  cue('2', 1.35, 2, 'there', 'A'),
]);
assert.equal(tight.length, 1);

const long = groupSentences([
  cue('a', 0, 8, 'part one', 'A'),
  cue('b', 8, 16, 'part two', 'A'),
  cue('c', 16, 24, 'part three', 'A'),
]);
assert.deepEqual(long.map(item => item.sourceIds), [['a', 'b'], ['c']]);
assert.ok(long[0].end - long[0].start <= 20);
const tooLong = groupSentences([
  cue('a', 0, 12, 'long start', 'A'),
  cue('b', 12, 25, 'long end', 'A'),
]);
assert.equal(tooLong.length, 2);

const zhComma = groupSentences([
  cue('1', 0, 1, '我们今天，', 'A'),
  cue('2', 1.1, 2, '去公园', 'A'),
]);
assert.equal(zhComma.length, 1);
assert.equal(zhComma[0].src, '我们今天， 去公园');
assert.equal(zhComma[0].id, '1+2');
const zhStop = groupSentences([
  cue('1', 0, 1, '好的。', 'A'),
  cue('2', 1.1, 2, '再走', 'A'),
]);
assert.deepEqual(zhStop.map(item => item.id), ['1', '2']);
const zhQuestion = groupSentences([
  cue('1', 0, 1, '好吗？', 'A'),
  cue('2', 1.1, 2, '走吧', 'A'),
]);
assert.equal(zhQuestion.length, 2);
const exact = groupSentences([
  cue('a', 0, 10, 'one', 'A'),
  cue('b', 10, 20, 'two', 'A'),
]);
assert.equal(exact.length, 1);
assert.equal(exact[0].end - exact[0].start, 20);

const abbrev = groupSentences([
  cue('1', 0, 0.4, 'Dr.', 'A'),
  cue('2', 0.5, 1.4, 'Smith arrived', 'A'),
]);
assert.equal(abbrev.length, 1);
assert.equal(abbrev[0].src, 'Dr. Smith arrived');
const decimal = groupSentences([
  cue('1', 0, 1, 'It is 3.14.', 'A'),
  cue('2', 1.1, 2, 'Next', 'A'),
]);
assert.equal(decimal.length, 2);
const decimalOpen = groupSentences([
  cue('1', 0, 1, 'It is 3.14', 'A'),
  cue('2', 1.1, 2, 'exactly', 'A'),
]);
assert.equal(decimalOpen.length, 1);
const falseStop = groupSentences([
  cue('1', 0, 1, "I don't think.", 'A'),
  cue('2', 1.1, 2, 'this is fine', 'A'),
]);
assert.equal(falseStop.length, 2);
const zhSemi = groupSentences([
  cue('1', 0, 1, '先这样；', 'A'),
  cue('2', 1.1, 2, '再看', 'A'),
]);
assert.equal(zhSemi.length, 2);
const ordered = groupSentences([
  cue('2', 5, 6, 'Later.', 'A'),
  cue('1', 0, 1, 'First.', 'A'),
]);
assert.deepEqual(ordered.map(item => item.id), ['1', '2']);

const mixed = [
  cue('1', 0, 1, 'Hello', 'A'),
  cue('2', 1.1, 2, 'there.', 'A'),
  cue('3', 2.1, 3, 'Yes', 'B'),
  cue('4', 10, 11, 'Later', 'A'),
];
const covered = groupSentences(mixed);
assert.deepEqual(covered.flatMap(item => item.sourceIds), ['1', '2', '3', '4']);
assert.equal(new Set(covered.flatMap(item => item.sourceIds)).size, 4);
assert.deepEqual(covered.map(item => item.start), [...covered.map(item => item.start)].sort((a, b) => a - b));

assert.equal(budgetChars(0, 10), 38);
assert.equal(budgetChars(5, 8), 11);
assert.equal(budgetChars(1, 1), 1);
assert.equal(budgetChars(0, 0.1), 1);

const zhText = '今天天气很好我们去公园';
const restored = await restoreSentenceBreaks(zhText, async (system, userText) => {
  assert.match(system, /breaks/);
  assert.equal(userText, zhText);
  return '{"breaks":[6]}';
});
assert.deepEqual(restored.breaks, [6]);
assert.deepEqual(restored.parts, ['今天天气很好', '我们去公园']);
assert.equal(restored.parts.join(''), zhText);

const spaced = await restoreSentenceBreaks('hello world today', async () => '{"breaks":[5,11]}');
assert.deepEqual(spaced.breaks, [5, 11]);
assert.equal(spaced.parts.join(''), 'hello world today');

assert.equal(await restoreSentenceBreaks('hello world', async () => '{"breaks":[3]}'), null);
assert.equal(await restoreSentenceBreaks(zhText, async () => '{"text":"另一段话","breaks":[6]}'), null);
assert.equal(await restoreSentenceBreaks(zhText, async () => '今天天气很好。我们去公园'), null);
assert.equal(await restoreSentenceBreaks('hello world', async () => '{"breaks":[99]}'), null);
assert.equal(await restoreSentenceBreaks('hello world', async () => '{"breaks":[6,5]}'), null);
assert.equal(await restoreSentenceBreaks(zhText, async () => { throw new Error('network'); }), null);
assert.equal(await restoreSentenceBreaks('', async () => '{"breaks":[]}'), null);
assert.equal(await restoreSentenceBreaks(zhText), null);

const longHistory = Array.from({ length: 20 }, (_, i) => ({ src: `s${i}`, zh: `译${i}` }));
const trimmed = buildTranslationInput({
  brief: '简'.repeat(900),
  glossary: [{ source: 'neural', target: '神经', count: 1 }, { source: 'scale', target: '规模', count: 2 }, { source: 'ready', target: '已确认' }],
  history: longHistory,
  current: Array.from({ length: 18 }, (_, i) => ({ id: `c${i}`, src: `cue ${i}`, start: i, end: i + 1, budgetChars: 8, speaker: 'A' })),
  lookahead: [
    { id: 'l0', src: 'w'.repeat(500) },
    { id: 'l1', src: 'x'.repeat(400) },
    { id: 'l2', src: 'y'.repeat(100) },
    { id: 'l3', src: 'z' },
    { id: 'l4', src: 'extra' },
  ],
});
assert.equal([...trimmed.brief].length, 800);
assert.equal(trimmed.history.length, 12);
assert.deepEqual(trimmed.history[0], { src: 's8', zh: '译8' });
assert.deepEqual(trimmed.glossary, [{ source: 'scale', target: '规模' }, { source: 'ready', target: '已确认' }]);
assert.equal(trimmed.current.length, 15);
assert.equal(trimmed.current[0].budgetChars, 8);
assert.ok(trimmed.lookahead.length >= 2 && trimmed.lookahead.length <= 4);
assert.ok(trimmed.lookahead.reduce((n, item) => n + [...item.src].length, 0) <= 800);
assert.equal(trimmed.lookahead.some(item => item.src.includes('extra')), false);
const heavy = buildTranslationInput({
  history: Array.from({ length: 10 }, (_, i) => ({ src: '源'.repeat(400), zh: '译'.repeat(400), id: i })),
  current: [{ id: 'only', src: 'now', start: 0, end: 2 }],
  lookahead: [],
});
assert.ok(heavy.history.length < 8);
assert.ok(heavy.history.reduce((n, item) => n + [...item.src].length + [...item.zh].length, 0) <= 3000);
assert.equal(heavy.current[0].budgetChars, 8);
assert.deepEqual(splitZhProportional('甲乙丙丁', [{ src: 'ab' }, { src: 'ab' }]), ['甲乙', '丙丁']);
assert.deepEqual(splitZhProportional('甲乙丙', [{ src: 'a' }, { src: 'aa' }]).join(''), '甲乙丙');
const restoredUnits = sentenceUnitsFromRestore([
  cue('1', 0, 1, '今天天气', 'A'),
  cue('2', 1, 2, '很好', 'A'),
], { breaks: [4], parts: ['今天天气', '很好'] });
assert.equal(restoredUnits, null);
const spacedUnits = sentenceUnitsFromRestore([
  cue('1', 0, 1, 'aaaa', 'A'),
  cue('2', 1.1, 2, 'bbbb', 'A'),
], { breaks: [5], parts: ['aaaa ', 'bbbb'] });
assert.equal(spacedUnits.length, 2);
assert.equal(spacedUnits.map(item => item.src).join('|'), 'aaaa|bbbb');
assert.equal(resolveSentenceEdit({ id: '1+2', sourceIds: ['1', '2'], zh: '新' }, { '1+2': '整句' }), '整句');
assert.equal(resolveSentenceEdit({ id: '1+2', sourceIds: ['1', '2'], zh: '新' }, { '1': '只改前半' }), '只改前半');
assert.equal(resolveSentenceEdit({ id: '1+2', sourceIds: ['1', '2'], zh: '新' }, { '1': '甲', '2': '乙' }), undefined);
assert.equal(endsSentence('Dr. Smith'), false);
assert.equal(endsSentence('Done.'), true);
assert.equal(hanCount('汉字abc'), 2);

console.log('PASS sentences: speaker, overlap, gap, duration, punctuation, breaks');
