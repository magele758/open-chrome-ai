import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepareDubPlan, runPlannedInterpret } from '../lib/planned-interpret.js';
import { subtitleSpeaker, subtitleWindowEnd } from '../lib/dub-timeline.js';
const settings={text:{baseUrl:'https://text.test',model:'test'},asr:{baseUrl:'https://asr.test',model:'test'},tts:{baseUrl:'https://tts.test',preparationMode:'progressive',bufferSeconds:5}};
const signal=new AbortController().signal;
const chat=async(_,{messages})=>{const p=JSON.parse(messages[1].content);return p.current?JSON.stringify({lines:p.current.map(c=>({ids:[c.id],zh:c.src}))}):'context';};
const noCache={cacheGet:async()=>null,cacheSet:async()=>true};
const spans=[{start:0,end:4,speaker:'A'},{start:4,end:8,speaker:'B'},{start:8,end:12,speaker:'A'},{start:12,end:24,speaker:'B'}].map(s=>({...s,kind:'speech'}));
const subtitles=spans.map((s,i)=>({id:`sub:${i}`,start:s.start,end:s.end,src:`sentence ${i}`,speaker:'spk:0'}));
const source={duration:24,subtitles,analyze:async()=>({duration:24,spans})};
const plan=await prepareDubPlan({source,settings,signal,chat,...noCache,transcribe:async()=>{throw Error('should use subtitle text');}});
assert.deepEqual(plan.lines.map(l=>l.speaker),['A','B','A','B']);
const unknown=[{start:0,end:24,kind:'unknown',speaker:null}];
assert.notEqual(subtitleSpeaker(subtitles[0],unknown,0).speaker,subtitleSpeaker(subtitles[1],unknown,1).speaker);
let asrCalls=0;
const mixed=await prepareDubPlan({source:{...source,subtitles:[{id:'mixed',start:0,end:8,src:'two voices'}],slice:async(start,seconds)=>({start,seconds,blob:new Blob(['audio'])})},settings,signal,chat,...noCache,
 transcribe:async(_m,slice)=>{asrCalls++;return [{start:0,end:slice.seconds,text:'recognized speaker'}];}});
assert.ok(asrCalls>1);
assert.deepEqual(mixed.lines.map(l=>l.speaker),['A','B','A','B']);
assert.equal(subtitleWindowEnd([{start:11.92,end:14.64}],0,12,3224),14.64);

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<400;n++){if(fn())return;await sleep(10);}throw Error('timeout '+fn);}
const state={ok:true,currentTime:0,duration:24,paused:false,userPaused:false,seekRevision:0,readyState:4,playbackRate:1};
const abort=new AbortController(),audios=[],requests=[];
let releaseAnalysis;
const gate=new Promise(r=>releaseAnalysis=r);
const person=t=>t<4?'A':t<8?'B':t<12?'A':'B';
class AudioMock {constructor(){this.paused=true;audios.push(this);}pause(){this.paused=true;}async play(){this.paused=false;}removeAttribute(){}load(){}}
const running=runPlannedInterpret({tabId:1,sourceUrl:'https://fixture.test/subtitle-voices',settings,signal:abort.signal,
 openSource:async()=>({...source,analyze:async()=>{await gate;return {duration:24,spans};},close:async()=>{},slice:async(start,seconds)=>({start,end:start+seconds,seconds,blob:new Blob([person(start)])})}),
 video:async(cmd,arg={})=>{if(cmd==='control')state.paused=arg.action==='pause';return {...state};},
 getTtsRef:async()=>({buffer:new TextEncoder().encode('fixed'),type:'audio/wav'}),
 chat,...noCache,transcribe:async()=>{throw Error('ordinary subtitle cues need no ASR');},
 voiceRef:async b=>b,audioDuration:async()=>2,createAudio:()=>new AudioMock(),
 synthesizeTts:async(_m,text,{referenceBlob})=>{requests.push({text,ref:await referenceBlob.text()});return {blob:new Blob(['dub'])};}});
const outcome=running.then(value=>({value}),error=>({error}));
try {
 await until(()=>requests.length>=4&&audios.length===1&&!audios[0].paused);
 assert.deepEqual(requests.slice(0,4).map(r=>r.ref),['A','B','A','B'],'unlabeled subtitles must not share the first reference');
 // Speech can finish before the source interval: late analysis must not replay it.
 state.currentTime=2;audios[0].onended();releaseAnalysis();
 await until(()=>requests.length>=7);
 state.currentTime=4;
 await until(()=>audios.length>=2&&!audios[1].paused);
 assert.equal(audios[1].dubItem.zh,'sentence 1');
 assert.equal(audios[1].dubItem.speaker,'B');
 assert.equal(requests.filter(r=>r.text==='sentence 0').length,1);
 assert.ok(requests.filter(r=>r.text==='sentence 1').every(r=>r.ref==='B'));
} finally {abort.abort();releaseAnalysis();const result=await outcome;assert.equal(result.error?.name,'AbortError');}
console.log('PASS subtitle A/B/A, legacy spk:0 cache, per-cue provisional references, late-analysis playback, cross-speaker ASR');

if(process.argv[2]) {
 const cues=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const duration=Math.max(...cues.map(c=>c.end));
 let start=0,windows=0,counts=new Map(),oldCounts=new Map();
 for(let s=0;s<duration;s=s===0?12:s+24){const end=s+(s===0?12:24);for(const c of cues.filter(c=>c.end>s&&c.start<end))oldCounts.set(c.id,(oldCounts.get(c.id)||0)+1);}
 while(start<duration){const end=subtitleWindowEnd(cues,start,start+(windows?24:12),duration);assert.ok(end>start);for(const c of cues.filter(c=>c.end>start&&c.start<end))counts.set(c.id,(counts.get(c.id)||0)+1);start=end;windows++;}
 assert.equal(counts.size,cues.length);
 assert.ok([...counts.values()].every(n=>n===1));
 console.log(JSON.stringify({realSubtitleCues:cues.length,oldRepeatedCues:[...oldCounts.values()].filter(n=>n>1).length,newRepeatedCues:[...counts.values()].filter(n=>n>1).length,windows}));
}

// Exercise the real preparation/playback loops, not just boundary arithmetic.
{
 const captions=[{id:'a',start:0,end:11.92,src:'same words'},{id:'b',start:11.92,end:14.64,src:'boundary sentence'},{id:'c',start:14.64,end:30,src:'same words'},{id:'d',start:30,end:40,src:'last sentence'}];
 const state={ok:true,currentTime:0,duration:40,paused:false,userPaused:false,seekRevision:0,readyState:4,playbackRate:1};
 const abort=new AbortController(),played=[],translated=[];
 let release;const gate=new Promise(r=>release=r);
 class AudioMock{constructor(){this.paused=true;played.push(this);}pause(){this.paused=true;}async play(){this.paused=false;}removeAttribute(){}load(){}}
 const running=runPlannedInterpret({tabId:1,settings,signal:abort.signal,...noCache,
  openSource:async()=>({duration:40,subtitles:captions,close:async()=>{},analyze:async()=>{await gate;return {duration:40,spans:[{start:0,end:40,kind:'unknown',speaker:null}]};},slice:async(start,seconds)=>({start,seconds,blob:new Blob([String(start)])})}),
  video:async(cmd,arg={})=>{if(cmd==='control')state.paused=arg.action==='pause';return {...state};},
  chat:async(_m,input)=>{const p=JSON.parse(input.messages[1].content);translated.push(...p.current.map(c=>c.id));return chat(_m,input);},
  getTtsRef:async()=>null,voiceRef:async b=>b,audioDuration:async()=>2,createAudio:()=>new AudioMock(),synthesizeTts:async()=>({blob:new Blob(['dub'])})});
 const outcome=running.then(value=>({value}),error=>({error}));
 try{
  for(let i=0;i<captions.length;i++){
   state.currentTime=captions[i].start;
   await until(()=>played.length===i+1&&!played[i].paused);
   assert.equal(played[i].dubItem.zh,captions[i].src);
   assert.equal(played[i].dubItem.end,captions[i].end);
   played[i].onended();
  }
  assert.deepEqual(translated,['a','b','c','d'],'no duplicate translation at 12s; genuine repeated source words stay intact');
 }finally{abort.abort();release();const result=await outcome;assert.equal(result.error?.name,'AbortError');}
 console.log('PASS crossing-12s cue translated and played once; genuine repeated source sentences preserved');
}
