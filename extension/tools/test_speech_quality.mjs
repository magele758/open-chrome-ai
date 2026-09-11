import assert from 'node:assert/strict';
import { hasRunawayRepetition, isWeakSpeechText, isWhisperHallucination } from '../lib/speech-quality.js';
import { cleanTranslation, translateToZh } from '../lib/interpret.js';

const example = '社会,我们只能有两个研究的研究仅仅仅仅仅仅仅仅仅仅仅仅仅仅仅仅仅仅';
for (const text of [example, '这就是原因。'.repeat(6), 'Thank you for watching. '.repeat(4), 'study '.repeat(8)]) {
  assert.equal(hasRunawayRepetition(text), true, text);
}
for (const text of ['仅仅是两个研究。', '非常非常重要', '不，不，不是这样。', '研究的研究方法需要改进。', 'very very important', 'The study studies how people study.', '哈哈哈哈', '', '1234567890']) {
  assert.equal(hasRunawayRepetition(text), false, text);
}

// Whisper Hallucination tests
const userReportedHallucination = '中文字幕志愿者 中文字幕志愿者 李宗盛';
assert.equal(isWhisperHallucination(userReportedHallucination), true, 'user reported volunteer artifact');
assert.equal(isWhisperHallucination('中文字幕由志愿者提供'), true, 'canned volunteer watermark');
assert.equal(isWhisperHallucination('感谢收看，请不吝赐教'), true, 'polite silence watermark');
assert.equal(isWhisperHallucination('Subtitles by the Amara.org community'), true, 'Amara English artifact');
assert.equal(isWhisperHallucination('Thank you for watching.'), true, 'YouTube closing artifact');
assert.equal(isWhisperHallucination('Please subscribe to my channel'), true, 'subscribe artifact');
assert.equal(isWhisperHallucination('李宗盛 李宗盛'), true, 'repeated artist name artifact');
assert.equal(
  isWhisperHallucination('李宗盛', { sliceSeconds: 5, segments: [{ start: 0, end: 29.98 }] }),
  true,
  'inflated duration silence collapse',
);

// Legitimate speech preservation
assert.equal(
  isWhisperHallucination('今天我们来聊聊李宗盛的音乐生涯，他在华语乐坛有着举足轻重的地位。'),
  false,
  'valid discourse mentioning artist',
);
assert.equal(isWhisperHallucination('非常非常重要'), false, 'valid Chinese sentence');
assert.equal(isWhisperHallucination('hello world'), false, 'valid English phrase');

let requests = 0;
globalThis.fetch = async () => { requests++; return Response.json({ choices: [{ message: { content: example } }] }); };
const model = { baseUrl: 'https://llm.test/v1', model: 'test', apiKey: 'test-key' };
await assert.rejects(translateToZh(model, example), /语音识别出现异常重复/);
assert.equal(requests, 0, 'reject bad ASR even when Chinese bypasses translation');
await assert.rejects(translateToZh(model, 'We have two studies.'), /翻译结果出现异常重复/);
assert.equal(requests, 1);
assert.throws(() => cleanTranslation('正常开头。'.repeat(1) + 'x'.repeat(250) + example, ''), /异常重复/, 'validate before truncation');
assert.throws(() => cleanTranslation('', example), /语音识别出现异常重复/, 'fallback cannot bypass validation');
assert.equal(await translateToZh(model, '非常非常重要'), '非常非常重要');
assert.equal(requests, 1, 'normal Chinese is preserved');

// Verify translateToZh rejects hallucination without bypassing
await assert.rejects(
  translateToZh(model, userReportedHallucination),
  /出现模型静音幻觉/,
  'hallucination rejected cleanly in translation',
);

assert.equal(isWeakSpeechText('嗯'), true);
assert.equal(isWeakSpeechText('好的'), false);
assert.equal(isWeakSpeechText('a', 5), true);
assert.equal(isWeakSpeechText('hello there', 5), false);
console.log('PASS repetition & whisper hallucination guard: reported example, volunteer/credits, duration collapse, normal discourse');

