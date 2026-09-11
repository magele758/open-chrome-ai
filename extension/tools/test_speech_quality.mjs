import assert from 'node:assert/strict';
import { hasRunawayRepetition, isWeakSpeechText } from '../lib/speech-quality.js';
import { cleanTranslation, translateToZh } from '../lib/interpret.js';

const example = '社会,我们只能有两个研究的研究仅仅仅仅仅仅仅仅仅仅仅仅仅仅仅仅仅仅';
for (const text of [example, '这就是原因。'.repeat(6), 'Thank you for watching. '.repeat(4), 'study '.repeat(8)]) {
  assert.equal(hasRunawayRepetition(text), true, text);
}
for (const text of ['仅仅是两个研究。', '非常非常重要', '不，不，不是这样。', '研究的研究方法需要改进。', 'very very important', 'The study studies how people study.', '哈哈哈哈', '', '1234567890']) {
  assert.equal(hasRunawayRepetition(text), false, text);
}
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
assert.equal(isWeakSpeechText('嗯'), true);
assert.equal(isWeakSpeechText('好的'), false);
assert.equal(isWeakSpeechText('a', 5), true);
assert.equal(isWeakSpeechText('hello there', 5), false);
console.log('PASS repetition guard: reported example, ASR bypass, model output, fallback, normal emphasis');
