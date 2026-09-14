import assert from 'node:assert/strict';
import { validateAnalysis, recognitionWindows, validateDubTranslation, fitDub, continuousReadySeconds, voiceCandidates, parseTolerantJson } from '../lib/dub-timeline.js';
const spans = [
  {start:0,end:3,kind:'music',speaker:null},
  {start:3,end:8,kind:'speech',speaker:'A'},
  {start:8,end:10,kind:'speech',speaker:'B'},
  {start:10,end:12,kind:'speech',speaker:null,overlap:true},
  {start:12,end:15,kind:'silence',speaker:null},
];
assert.equal(validateAnalysis({duration:15,spans},15),spans);
assert.throws(()=>validateAnalysis({duration:15,spans:spans.slice(1)},15),/缺口/);
assert.deepEqual(recognitionWindows(spans).map(s=>[s.start,s.end,s.speaker]),[[3,8,'A'],[8,10,'B'],[10,12,null]]);
assert.equal(voiceCandidates(spans).size,1,'only a clean single speaker >=3s is a voice reference');
const cues=[{id:'1',start:3,end:8,src:'Question?',speaker:'A'},{id:'2',start:8,end:10,src:'No.',speaker:'B'}];
assert.throws(()=>validateDubTranslation({lines:[{ids:['1','2'],zh:'一起'}]},cues),/不同说话人/);
assert.throws(()=>validateDubTranslation({lines:[{ids:['1'],zh:'问题'}]},cues),/遗漏/);
const lines=validateDubTranslation({lines:[{ids:['1'],zh:'问题？'},{ids:['2'],zh:'不。'}]},cues);
assert.equal(continuousReadySeconds(lines,new Map([['1',true]]),0,15),8,'a future ready segment does not bridge a failed preceding segment');
assert.equal(continuousReadySeconds(lines,new Map([['2',true]]),0,15),3);
const fitted=fitDub(lines[0],8,8);
assert.equal(fitted.slotEnd,8); assert.equal(fitted.rate,1.12); assert(fitted.holdSeconds>2);
assert.equal(fitDub(lines[0],6,10).slotEnd,9.5,'limited borrowing of silence');

// Tolerant JSON parsing tests
// 1. Unescaped quotes inside "zh" (Expected ',' or '}' after property value in JSON at position 42)
const malformedWithQuotes = '{"lines":[{"ids":["0:14"],"zh":"他说"好的"然后离开"}]}';
const parsedQuotes = parseTolerantJson(malformedWithQuotes);
assert.equal(parsedQuotes.lines[0].zh, '他说"好的"然后离开');

// 2. Markdown fence with conversational wrapper text
const fenceWrapped = '思考完成，这里是口播稿：\n```json\n{"lines":[{"ids":["1"],"zh":"这是内容"}]}\n```\n请确认。';
const parsedFence = parseTolerantJson(fenceWrapped);
assert.equal(parsedFence.lines[0].zh, '这是内容');

// 3. Thinking tags
const thinkWrapped = '<think>分析角色语气并调整节奏...</think>{"lines":[{"ids":["1"],"zh":"思考后译文"}]}';
const parsedThink = parseTolerantJson(thinkWrapped);
assert.equal(parsedThink.lines[0].zh, '思考后译文');

// 4. Trailing commas & unescaped newline
const trailingComma = '{"lines":[{"ids":["1"],"zh":"换行\\n引文\\"测试\\"",},],}';
const parsedTrailing = parseTolerantJson(trailingComma);
assert.equal(parsedTrailing.lines[0].zh, '换行\n引文"测试"');

// 5. validateDubTranslation tolerance with unescaped quotes in raw string
const unescapedRaw = '{"lines":[{"ids":["1"],"zh":"他说"没问题""},{"ids":["2"],"zh":"否定。"}]}';
const validatedWithQuotes = validateDubTranslation(unescapedRaw, cues);
assert.equal(validatedWithQuotes.length, 2);
assert.equal(validatedWithQuotes[0].zh, '他说"没问题"');

// 6. Single cue tolerance: mismatched / missing id automatically maps to single cue
const singleCue = [{id:'sub:99',start:0,end:5,src:'Test cue',speaker:'A'}];
const singleRes = validateDubTranslation('{"lines":[{"ids":["0"],"zh":"单句容错测试"}]}', singleCue);
assert.equal(singleRes[0].id, 'sub:99');
assert.equal(singleRes[0].zh, '单句容错测试');

// 7. Raw array format tolerance
const arrayRes = validateDubTranslation('[{"ids":["1"],"zh":"第一句"},{"ids":["2"],"zh":"第二句"}]', cues);
assert.equal(arrayRes.length, 2);
assert.equal(arrayRes[1].zh, '第二句');

console.log('PASS timeline: full coverage, music skip, speaker boundaries, overlap, references, source ID completeness, time buffering, bounded rate, tolerant JSON parsing & quote escaping');

