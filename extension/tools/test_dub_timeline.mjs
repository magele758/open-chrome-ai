import assert from 'node:assert/strict';
import { validateAnalysis, recognitionWindows, validateDubTranslation, fitDub, continuousReadySeconds, voiceCandidates } from '../lib/dub-timeline.js';
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
console.log('PASS timeline: full coverage, music skip, speaker boundaries, overlap, references, source ID completeness, time buffering, bounded rate');
