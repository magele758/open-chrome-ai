import assert from 'node:assert/strict';
import { prepareSpeakerReference } from '../lib/interpret-reference.js';
import { stripSubtitleDirections } from '../lib/subtitle-text.js';
import { prepareDubPlan, runPlannedInterpret } from '../lib/planned-interpret.js';
const attempts=[];
const source={slice:async(start,seconds)=>{attempts.push([start,seconds]);return {blob:new Blob([String(start)])};}};
const speech=(start,end,speaker)=>({start,end,speaker,kind:'speech'});
let ref=await prepareSpeakerReference({line:speech(60,61,'A'),spans:[speech(0,14,'A'),speech(20,30,'B')],source,voiceRef:async b=>Number(await b.text())===7?new Blob(['A']):null});
assert.equal(await ref.text(),'A');
assert.deepEqual(attempts,[[0,7],[3.5,7],[7,7]],'skip leading pause while staying inside A');
attempts.length=0;
ref=await prepareSpeakerReference({line:speech(60,61,'A'),spans:[speech(0,14,'A'),speech(20,24,'A'),speech(30,40,'B')],source,voiceRef:async b=>Number(await b.text())===20?new Blob(['A']):null});
assert.equal(await ref.text(),'A','try another same-speaker turn if the longest fails quality');
assert.ok(attempts.every(([start])=>start<30));
attempts.length=0;
ref=await prepareSpeakerReference({line:speech(60,61,'unassigned:subtitle:0'),spans:[speech(20,30,'A')],source,voiceRef:async()=>null});
assert.equal(ref,null);
assert.deepEqual(attempts,[[60,1]],'unknown identity cannot borrow another speaker across a gap');
for(const text of ['[laughter]','（叹气）','【微笑】','(audience applause)','♪ [music] ♪'])assert.equal(stripSubtitleDirections(text),'');
assert.equal(stripSubtitleDirections('Hello [laughter] there (sighs).'),'Hello there .');
assert.equal(stripSubtitleDirections('She sighed (not because of the music).'),'She sighed (not because of the music).');
assert.equal(stripSubtitleDirections('她微笑着说（这是真的）。'),'她微笑着说（这是真的）。');
const settings={text:{baseUrl:'https://text.test',model:'m'},asr:{baseUrl:'https://asr.test',model:'m'},tts:{baseUrl:'https://tts.test',preparationMode:'full'}};
const noCache={cacheGet:async()=>null,cacheSet:async()=>true};
const chat=async(_,{messages})=>{const p=JSON.parse(messages[1].content);return p.current?JSON.stringify({lines:p.current.map(c=>({ids:[c.id],zh:'（微笑）'+c.src}))}):'context';};
const cues=[{id:'a',start:0,end:14,src:'Hello [laughter] there.'},{id:'b',start:14,end:18,src:'Next person.'},{id:'direction',start:18,end:19,src:'[sighs]'},{id:'c',start:60,end:61,src:'Hello again.'}];
const spans=[speech(0,14,'A'),speech(14,18,'B'),{start:18,end:60,kind:'silence',speaker:null},speech(60,61,'A')];
const src={duration:61,subtitles:cues,analyze:async()=>({duration:61,spans}),slice:source.slice,close:async()=>{}};
const plan=await prepareDubPlan({source:src,settings,signal:new AbortController().signal,chat,...noCache});
assert.equal(plan.lines.length,3);
assert.ok(plan.lines.every(l=>!/[\[\]]/.test(l.src)));
assert.ok(plan.lines.every(l=>!l.zh.includes('微笑')), 'model-added directions must not reach TTS');
const onlyDirections=await prepareDubPlan({source:{...src,subtitles:[cues[2]]},settings,signal:new AbortController().signal,chat:async()=>{throw Error('must not translate direction');},transcribe:async()=>{throw Error('must not transcribe direction');},...noCache});
assert.equal(onlyDirections.lines.length,0);
const state={ok:true,currentTime:0,duration:61,paused:false,userPaused:false,seekRevision:0,readyState:4,playbackRate:1};
const abort=new AbortController(),voices=[];
class Audio{constructor(){this.paused=true;}pause(){this.paused=true;}async play(){this.paused=false;}removeAttribute(){}load(){}}
const run=runPlannedInterpret({tabId:1,settings,signal:abort.signal,openSource:async()=>src,
 video:async(cmd,arg={})=>{if(cmd==='control')state.paused=arg.action==='pause';return {...state};},chat,...noCache,
 getTtsRef:async()=>({buffer:new TextEncoder().encode('fixed'),type:'audio/wav'}),
 voiceRef:async b=>{const start=Number(await b.text());return start===7?new Blob(['A']):start===14?new Blob(['B']):null;},
 audioDuration:async()=>1,createAudio:()=>new Audio(),synthesizeTts:async(_,text,{referenceBlob})=>{voices.push([text,await referenceBlob.text()]);return {blob:new Blob(['dub'])};}});
const outcome=run.then(value=>({value}),error=>({error}));
try{for(let i=0;i<200&&voices.length<3;i++)await new Promise(r=>setTimeout(r,10));assert.deepEqual(voices.map(v=>v[1]),['A','B','A']);assert.ok(voices.every(v=>!v[0].includes('sighs')));}finally{abort.abort();assert.equal((await outcome).error?.name,'AbortError');}
console.log('PASS pause recovery, alternative same-speaker reference, A/B/gap/A reuse, unknown-speaker isolation, directions excluded from translation/TTS');

// Use actual PCM and the production quality gate: silence at the start should
// cause a later sample to be selected, without weakening the quality threshold.
{
 const { encodeMonoWav } = await import('../lib/tts.js');
 const { readPcmWav } = await import('../lib/downloaded-audio-source.js');
 const { assessVoiceQuality } = await import('../lib/tab-audio-record.js');
 const sr=16000,recorded=[];
 const pcmSource={slice:async(start,seconds)=>{
  recorded.push(start);const samples=new Float32Array(seconds*sr);
  for(let i=0;i<samples.length;i++){const t=start+i/sr;if(t<7)continue;const env=Math.sin(t*3*Math.PI)>0?.4:.005;samples[i]=env*(.7*Math.sin(2*Math.PI*250*t)+.3*Math.sin(2*Math.PI*700*t));}
  return {blob:encodeMonoWav(samples,sr)};
 }};
 const selected=await prepareSpeakerReference({line:speech(50,51,'A'),spans:[speech(0,14,'A')],source:pcmSource,voiceRef:async b=>{
  const pcm=readPcmWav(await b.arrayBuffer()),view=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength),samples=new Float32Array(pcm.length/2);
  for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
  return assessVoiceQuality(samples,sr).ok?b:null;
 }});
 assert.ok(selected);assert.equal(recorded[0],0);assert.ok(recorded.length>1&&recorded.at(-1)>0);
 console.log('PASS actual PCM silence-leading reference recovered using unchanged voice-quality gate');
}
