import assert from 'node:assert/strict';
import { prepareDubPlan, runPlannedInterpret } from '../lib/planned-interpret.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await sleep(10);}throw Error('timeout '+fn);}
const blob=new Blob([new Uint8Array(2000)],{type:'audio/wav'});
const settings={text:{baseUrl:'https://text.test',model:'m',apiKey:'k'},asr:{baseUrl:'https://asr.test/v1',model:'w'},tts:{baseUrl:'https://tts.test',preparationMode:'full',bufferSeconds:5}};
const spans=[{start:0,end:2,kind:'music',speaker:null},{start:2,end:6,kind:'speech',speaker:'A'},{start:6,end:7,kind:'silence',speaker:null},{start:7,end:10,kind:'speech',speaker:'B'}];
const source={duration:10,analyze:async()=>({duration:10,fingerprint:'fixture',spans}),slice:async(start,seconds)=>({start,end:start+seconds,seconds,blob}),close:async()=>{}};
const cache=new Map(); const cacheGet=async k=>cache.get(k); const cacheSet=async(k,v)=>{cache.set(k,v);return true;};
let asr=0,chats=0;
const transcribe=async(_model,slice)=>{asr++;return [{start:0,end:slice.seconds,text:slice.start===2?'Question?':'No.'}];};
const chat=async(_model,{messages})=>{chats++;const input=JSON.parse(messages[1].content);return input.current?JSON.stringify({lines:input.current.map(c=>({ids:[c.id],zh:c.src==='No.'?'不。':'问题？'}))}):'A提问，B否定回答。';};
const plan=await prepareDubPlan({source,settings,signal:new AbortController().signal,transcribe,chat,cacheGet,cacheSet});
assert.equal(asr,2);assert.equal(plan.lines.length,2);assert.equal(plan.lines[1].speaker,'B');
assert.deepEqual(plan.lines.map(l=>[l.start,l.end]),[[2,6],[7,10]]);
const requests=chats;
await prepareDubPlan({source,settings,signal:new AbortController().signal,transcribe,chat,cacheGet,cacheSet});
assert.equal(asr,2);assert.equal(chats,requests,'completed original and translated documents are reused');
let dubCalls=0;
for(const mode of ['full','buffered']){
 const state={ok:true,currentTime:0,duration:10,paused:false,userPaused:false,seekRevision:0,readyState:4,playbackRate:1};
 let edit;
 const commands=[],audios=[];const abort=new AbortController();let release;
 const gate=new Promise(r=>release=r);
 const video=async(cmd,arg={})=>{commands.push(cmd);if(cmd==='control')state.paused=arg.action==='pause';if(cmd==='seek'){state.currentTime=arg.seconds;state.seekRevision++;}return {...state};};
 class AudioMock{constructor(){this.paused=true;this.currentTime=0;audios.push(this);}pause(){this.paused=true;}async play(){this.paused=false;}removeAttribute(){}load(){}}
 const running=runPlannedInterpret({tabId:1,settings:{...settings,tts:{...settings.tts,preparationMode:mode}},signal:abort.signal,video,openSource:async()=>source,transcribe,chat,cacheGet,cacheSet:async()=>true,
  onEditable:fn=>{edit=fn;},voiceRef:async b=>b,audioDuration:async()=>6,createAudio:()=>new AudioMock(),
  synthesizeTts:async()=>{dubCalls++;if(dubCalls%2===0)await gate;return {blob};},
 });
 try{
  await until(()=>dubCalls===(mode==='full'?2:4));
  if(mode==='full'){assert(state.paused,'full mode cannot start before all speech audio is ready');release();}
  await until(()=>!state.paused);
  assert(!commands.includes('restore'), 'muted original stays off through the opening music gap');
  state.currentTime=2;await until(()=>audios.length===1&&!audios[0].paused);
  state.userPaused=true;state.paused=true;await until(()=>audios[0].paused);
  state.userPaused=false;state.paused=false;await until(()=>!audios[0].paused);
  state.currentTime=7;await until(()=>state.paused);
  assert(!audios[0].paused,'long speech finishes while video holds');
  audios[0].onended();
  if(mode==='buffered'){await sleep(100);assert(state.paused,'missing next dub holds video');release();}
  await until(()=>audios.length===2&&!audios[1].paused);
  state.currentTime=2;state.seekRevision++;await until(()=>audios.length===3);
  assert.equal(dubCalls,mode==='full'?2:4,'seek must replay cached audio without new TTS');
  if(mode==='buffered'){await edit(plan.lines[0].id,'修改后的问题。');await until(()=>dubCalls===5);await until(()=>audios.length===4);assert.equal(audios[3].dubItem.zh,'修改后的问题。');}
 }finally{abort.abort();release();await assert.rejects(running,{name:'AbortError'});}
 assert(commands.includes('restore'));
}
console.log('PASS planned interpretation: whole context, stable speaker references, cache reuse, full/buffered modes, pause, long speech, starvation, seek without regeneration, abort cleanup');

// A separated accompaniment follows source time, not slowed/held translated speech.
{
 const state={ok:true,currentTime:0,duration:6,paused:false,userPaused:false,seekRevision:0,readyState:4,playbackRate:1};
 const audio=[],tracks=[],abort=new AbortController();
 class A{constructor(){this.paused=true;this.currentTime=0;this.duration=6;audio.push(this);}pause(){this.paused=true;}async play(){this.paused=false;}removeAttribute(){}load(){}}
 const backgroundSource={duration:6,close:async()=>{},analyze:async()=>({duration:6,fingerprint:'background-fixture',background:true,spans:[{start:0,end:5,kind:'speech',speaker:'A',music:.2},{start:5,end:6,kind:'silence',speaker:null}]}),slice:async(start,seconds,track)=>{tracks.push(track);return {start,end:start+seconds,seconds,blob};}};
 const running=runPlannedInterpret({tabId:1,settings,signal:abort.signal,openSource:async()=>backgroundSource,video:async(cmd,arg={})=>{if(cmd==='control')state.paused=arg.action==='pause';return {...state};},transcribe,chat,cacheGet:async()=>null,cacheSet:async()=>true,voiceRef:async b=>b,audioDuration:async()=>8,createAudio:()=>new A(),synthesizeTts:async()=>({blob})});
 try{
  await until(()=>audio.length===2&&!audio[0].paused&&!audio[1].paused);
  assert(tracks.includes('background'));
  state.userPaused=true;state.paused=true;await until(()=>audio.every(a=>a.paused));
  state.userPaused=false;state.paused=false;state.currentTime=6;
  await until(()=>state.paused&&!audio[1].paused);
  await until(()=>audio[0].paused);
 }finally{abort.abort();await assert.rejects(running,{name:'AbortError'});}
 console.log('PASS separated background follows video pause while long speech continues');
}

// An hour-long source must start while whole-file analysis and later ASR are still blocked.
{
 const state={ok:true,currentTime:0,duration:3600,paused:false,userPaused:false,seekRevision:0,readyState:4,playbackRate:1};
 const abort=new AbortController(),audio=[],starts=[],translated=[];
 let releaseAnalysis,releaseLater,closed=false;
 const analysisGate=new Promise(r=>releaseAnalysis=r), laterGate=new Promise(r=>releaseLater=r);
 class A{constructor(){this.paused=true;audio.push(this);}pause(){this.paused=true;}async play(){this.paused=false;}removeAttribute(){}load(){}}
 const progressiveSource={duration:3600,close:async()=>{closed=true;},analyze:async()=>{await analysisGate;return {duration:3600,spans:[{start:0,end:3600,kind:'unknown',speaker:null}]};},slice:async(start,seconds)=>({start,end:start+seconds,seconds,blob:new Blob([String(start)])})};
 const running=runPlannedInterpret({tabId:1,sourceUrl:'https://fixture.test/hour',settings:{...settings,tts:{...settings.tts,preparationMode:'progressive'}},signal:abort.signal,
  openSource:async()=>progressiveSource,video:async(cmd,arg={})=>{if(cmd==='control')state.paused=arg.action==='pause';return {...state};},
  transcribe:async(_m,slice)=>{starts.push(slice.start);if(starts.length===2)await laterGate;return [{start:0,end:slice.seconds,text:'A complete sentence.'}];},
  chat:async(_m,{messages})=>{const input=JSON.parse(messages[1].content);assert(input.current,'no whole-document summary barrier in progressive mode');translated.push(input);return JSON.stringify({lines:input.current.map(c=>({ids:[c.id],zh:'完整的一句话。'}))});},
  cacheGet:async()=>null,cacheSet:async()=>true,voiceRef:async b=>b,audioDuration:async()=>12,createAudio:()=>new A(),synthesizeTts:async()=>({blob})});
 try{
  await until(()=>audio.length===1&&!audio[0].paused&&!state.paused);
  assert.deepEqual(starts,[0,12],'first audio starts before the second recognition completes');
  assert.equal(translated.length,1);
  assert.equal(audio[0].dubItem.start,0);assert.equal(audio[0].dubItem.end,12);
  audio[0].onended();state.currentTime=12;
  await until(()=>state.paused);
  assert.equal(audio.length,1,'unprocessed time is never treated as a silent gap');
  state.currentTime=900;state.seekRevision++;
  await sleep(100);assert(state.paused,'seek into unknown time stays paused');
  releaseLater();
  await until(()=>starts.includes(900));
  await until(()=>audio.some(a=>a.dubItem?.start===900&&!a.paused));
  assert(!starts.includes(36),'seek prioritizes the new position over old lookahead');
  assert(audio.find(a=>a.dubItem?.start===900).dubItem.end<=924,'source timestamps survive window offsets');
 }finally{abort.abort();releaseAnalysis();releaseLater();await assert.rejects(running,{name:'AbortError'});}
 assert(closed);
 console.log('PASS progressive hour source: early audio before global analysis/later ASR, unknown-gap hold, seek priority, absolute timing and cleanup');
}

// Native audio events can run while an awaited video command is in flight.
for (const race of ['ended-during-resume', 'error-during-background-read']) {
 const state={ok:true,currentTime:0,duration:6,paused:false,userPaused:false,seekRevision:0,readyState:4,playbackRate:1};
 const abort=new AbortController(), audios=[];
 let triggered=false, played=false;
 class A {
  constructor(){this.paused=true;this.duration=6;this.currentTime=0;this.plays=0;audios.push(this);}
  pause(){this.paused=true;}
  async play(){this.paused=false;this.plays++;if(this.dubItem)played=true;}
  removeAttribute(){} load(){}
 }
 const raceSource={duration:6,close:async()=>{},analyze:async()=>({duration:6,fingerprint:race,background:race.includes('background'),spans:[{start:0,end:6,kind:'speech',speaker:'A'}]}),slice:async(start,seconds)=>({start,end:start+seconds,seconds,blob})};
 const running=runPlannedInterpret({tabId:1,settings,signal:abort.signal,openSource:async()=>raceSource,
  video:async(cmd,arg={})=>{
   const voice=audios.find(a=>a.dubItem);
   if(cmd==='state'&&voice&&!triggered&&(race==='ended-during-resume'||played)) {
    triggered=true;
    if(race==='ended-during-resume')voice.onended();else voice.onerror();
   }
   if(cmd==='control')state.paused=arg.action==='pause';
   return {...state};
  },transcribe,chat,cacheGet:async()=>null,cacheSet:async()=>true,voiceRef:async b=>b,audioDuration:async()=>6,createAudio:()=>new A(),synthesizeTts:async()=>({blob})});
 // Attach rejection handling immediately so an intentional playback failure isn't unhandled.
 const outcome=running.then(value=>({value}),error=>({error}));
 try {
  await until(()=>triggered);
  if(race==='ended-during-resume') {
   state.ended=true;
   const result=await outcome;
   assert.ifError(result.error);
   assert.equal(audios[0].plays,0,'an ended/released audio must never be restarted');
  } else {
   const result=await outcome;
   assert.equal(result.error?.message,'中文配音播放失败','preserve the actual audio error when background is released during read');
  }
 }finally{abort.abort();await outcome;}
 console.log(`PASS audio lifetime race: ${race}`);
}

// Fixed user references must not override A/B/A; late analysis preserves committed voices.
{
 const state={ok:true,currentTime:0,duration:24,paused:false,userPaused:false,seekRevision:0,readyState:4,playbackRate:1};
 const abort=new AbortController(),audios=[],requests=[];
 let releaseAnalysis;
 const analysisGate=new Promise(r=>releaseAnalysis=r);
 const speakerAt=t=>t<4?'A':t<8?'B':t<12?'A':'B';
 const labeled=[{start:0,end:4,speaker:'A'},{start:4,end:8,speaker:'B'},{start:8,end:12,speaker:'A'},{start:12,end:24,speaker:'B'}].map(s=>({...s,kind:'speech'}));
 class A{constructor(){this.paused=true;audios.push(this);}pause(){this.paused=true;}async play(){this.paused=false;}removeAttribute(){}load(){}}
 const src={duration:24,close:async()=>{},analyze:async()=>{await analysisGate;return {duration:24,spans:labeled};},slice:async(start,seconds)=>({start,end:start+seconds,seconds,blob:new Blob([speakerAt(start)],{type:'audio/wav'})})};
 const running=runPlannedInterpret({tabId:1,sourceUrl:'https://fixture.test/speakers',settings:{...settings,tts:{...settings.tts,preparationMode:'progressive',contextMode:'cue'}},signal:abort.signal,openSource:async()=>src,
  video:async(cmd,arg={})=>{if(cmd==='control')state.paused=arg.action==='pause';return {...state};},
  getTtsRef:async()=>({buffer:new TextEncoder().encode('fixed'),type:'audio/wav'}),
  transcribe:async(_m,slice)=>slice.start===0&&slice.seconds===12?[{start:0,end:4,text:'First A',speaker:'0'},{start:4,end:8,text:'Then B',speaker:'1'},{start:8,end:12,text:'Again A',speaker:'0'}]:[{start:0,end:slice.seconds,text:speakerAt(slice.start),speaker:'0'}],
  chat:async(_m,{messages})=>{const input=JSON.parse(messages[1].content);return JSON.stringify({lines:input.current.map(c=>({ids:[c.id],zh:c.src}))});},
  cacheGet:async()=>null,cacheSet:async()=>true,voiceRef:async b=>b,audioDuration:async()=>4,createAudio:()=>new A(),synthesizeTts:async(_m,text,{referenceBlob})=>{requests.push({text,ref:await referenceBlob.text()});return {blob};}});
 const outcome=running.then(value=>({value}),error=>({error}));
 try{
  await until(()=>requests.length>=4&&audios.length===1&&!audios[0].paused);
  assert.deepEqual(requests.slice(0,3).map(r=>r.ref),['A','B','A'],'current speakers beat the saved fixed voice');
  assert.equal(requests[3].ref,'B','provider ID 0 in a new window must not reuse previous window speaker A');
  releaseAnalysis();
  await sleep(100);
  assert.equal(requests.length,4,'late analysis must not regenerate ready audio');
  assert(!audios[0].paused,'late analysis must not interrupt the current utterance');
  audios[0].onended();state.currentTime=4;
  await until(()=>audios.length>=2&&!audios[1].paused);
  assert.equal(audios[1].dubItem.zh,'Then B','committed text and voice remain playable');
  assert.equal(requests[1].ref,'B');
  assert.equal(audios[1].dubItem.start,4);
  assert(requests.filter(r=>r.text==='B').every(r=>r.ref==='B'),'all B utterances use B reference');
 }finally{abort.abort();releaseAnalysis();const result=await outcome;assert.equal(result.error?.name,'AbortError');}
 console.log('PASS A/B/A references, fixed-voice fallback priority, window-local IDs and late speaker refresh');
}

// A model that merges different speakers must recover without dropping speech or aborting the session.
{
 const recoveredCache=new Map(),calls=[];
 const args={source,settings:{...settings,tts:{...settings.tts,contextMode:'cue'}},signal:new AbortController().signal,transcribe,incrementalContext:'交替问答',cacheGet:async k=>recoveredCache.get(k),cacheSet:async(k,v)=>{recoveredCache.set(k,v);},
  chat:async(_m,{messages})=>{const input=JSON.parse(messages[1].content);calls.push(input);return JSON.stringify({lines:[{ids:input.current.map(c=>c.id),zh:input.current.length>1?'错误地合并的译文':input.current[0].src==='No.'?'不。':'问题？'}]});}};
 const result=await prepareDubPlan(args);
 assert.deepEqual(result.lines.map(l=>[l.speaker,l.start,l.end,l.zh]),[['A',2,6,'问题？'],['B',7,10,'不。']]);
 assert.deepEqual(calls.map(c=>c.current.length),[2,2,1,1],'bounded validation retries then isolated translation');
 assert.equal(calls[2].after[0].speaker,'B','isolated translation retains conversational context');
 const count=calls.length;await prepareDubPlan(args);assert.equal(calls.length,count,'recovered translations are cached');
 let failures=0;
 await assert.rejects(prepareDubPlan({...args,cacheGet:async()=>null,chat:async()=>{failures++;throw Error('HTTP 401');}}),/401/);
 assert.equal(failures,1,'authentication failure must not expand into per-cue requests');
 console.log('PASS merged-speaker recovery: no dropped cues, preserved voices/timestamps/context, bounded requests and cache reuse');
}

// Subtitle-first mode: when video subtitles exist, ASR is not needed and transcription is skipped.
{
  const subSource = {
    url: 'https://www.youtube.com/watch?v=mock',
    duration: 30,
    subtitles: [
      { id: 'sub:0', start: 1.0, end: 4.5, src: 'Hello and welcome to this speech.', speaker: 'spk:0' },
      { id: 'sub:1', start: 5.0, end: 9.0, src: 'Today we discuss artificial intelligence.', speaker: 'spk:0' }
    ],
    analyze: async () => ({ fingerprint: 'sub-fp', spans: [{ start: 0, end: 30, kind: 'speech', speaker: 'spk:0' }] }),
    slice: async () => ({ blob: new Blob([new Uint8Array(16000)], { type: 'audio/wav' }) })
  };
  const noAsrSettings = {
    ...settings,
    asr: { baseUrl: '', model: '' }
  };
  let transcribed = false;
  const result = await prepareDubPlan({
    source: subSource,
    settings: noAsrSettings,
    signal: new AbortController().signal,
    transcribe: async () => { transcribed = true; return []; },
    chat: async (_m, { messages }) => {
      const input = JSON.parse(messages[1].content);
      if (Array.isArray(input)) return '简要笔记';
      return JSON.stringify({ lines: (input.current || []).map(c => ({ ids: [c.id], zh: '测试译文' })) });
    }
  });
  assert.equal(transcribed, false, 'ASR transcription must be skipped when subtitles exist');
  assert.equal(result.lines.length, 2);
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[0].src, 'Hello and welcome to this speech.');
  console.log('PASS subtitle-first: native subtitles skip ASR and generate dub plan directly');
}


// An undecodable window must not cancel later speech or poison recognition cache.
{
 const saved = new Map();
 let requests = 0;
 const warnings = [];
 const options = { source, settings, signal: new AbortController().signal, chat,
  cacheGet: async key => saved.get(key), cacheSet: async (key, value) => saved.set(key, value),
  recoveryStatus: message => warnings.push(message),
  transcribe: async (_model, slice, { onUnrecognized }) => {
   requests++;
   if (slice.start === 2) { onUnrecognized({ start: 0, end: slice.seconds }); return []; }
   return [{ start: 0, end: slice.seconds, text: 'No.' }];
  },
 };
 const partial = await prepareDubPlan(options);
 assert.equal(partial.incompleteRecognition, true);
 assert.equal(partial.lines.length, 1);
 assert.equal(partial.lines[0].start, 7);
 assert(warnings[0].includes('2.0–6.0'));
 await prepareDubPlan(options);
 assert.equal(requests, 3, 'retry missing window and reuse successful window');
 console.log('PASS partial ASR continues with later speech and preserves retryable gaps');
}

{
  const sentenceSettings = { ...settings, tts: { ...settings.tts, contextMode: 'sentence', preparationMode: 'progressive' } };
  const subs = {
    duration: 8,
    subtitles: [
      { id: '1', start: 0.2, end: 1.2, src: 'Hello', speaker: 'A' },
      { id: '2', start: 1.3, end: 2.4, src: 'there', speaker: 'A' },
      { id: '3', start: 3.2, end: 4.8, src: 'Next point.', speaker: 'A' },
    ],
    analyze: async () => ({ duration: 8, fingerprint: 'sentence-merge', spans: [{ start: 0, end: 8, kind: 'speech', speaker: 'A' }] }),
    slice: async (start, seconds) => ({ start, end: start + seconds, seconds, blob }),
  };
  const seen = [];
  const merged = await prepareDubPlan({
    source: subs, settings: sentenceSettings, signal: new AbortController().signal,
    windowed: true, skipBrief: true, getBrief: () => '神经网络入门', extraLookahead: [{ id: 'later', src: 'See you tomorrow.' }],
    priorLines: [{ src: 'Earlier point.', zh: '前面说过。' }],
    chat: async (_m, { messages }) => {
      const system = messages[0].content;
      const input = JSON.parse(messages[1].content);
      if (!Array.isArray(input?.current)) return '简报';
      seen.push(input);
      assert.equal(typeof input.brief, 'string');
      assert.ok(Array.isArray(input.history));
      assert.ok(Array.isArray(input.lookahead));
      assert.equal(system.startsWith('全文简报'), true);
      assert.doesNotMatch(system, /禁止跨句合并/);
      return JSON.stringify({ lines: input.current.map(item => ({ ids: [item.id], zh: item.src === 'Hello there' ? '你好' : '下一点。', terms: [{ source: 'Hello', target: '你好' }] })) });
    },
    cacheGet: async () => null, cacheSet: async () => true,
  });
  assert.equal(merged.lines.length, 2);
  assert.deepEqual(merged.lines[0].sourceIds, ['1', '2']);
  assert.equal(merged.lines[0].id, '1+2');
  assert.equal(seen[0].brief, '神经网络入门');
  assert.equal(seen[0].history.length, 1);
  assert.equal(seen[0].lookahead[0].src, 'See you tomorrow.');
  assert.ok(seen[0].current[0].budgetChars > 0);
  const cueSettings = { ...settings, tts: { ...settings.tts, contextMode: 'cue' } };
  let cueSystem = '';
  const split = await prepareDubPlan({
    source: subs, settings: cueSettings, signal: new AbortController().signal,
    chat: async (_m, { messages }) => {
      cueSystem = messages[0].content;
      const input = JSON.parse(messages[1].content);
      if (!Array.isArray(input?.current)) return '笔记';
      return JSON.stringify({ lines: input.current.map(item => ({ ids: [item.id], zh: '逐条' })) });
    },
    cacheGet: async () => null, cacheSet: async () => true,
  });
  assert.equal(split.lines.length, 3);
  assert.match(cueSystem, /禁止跨句合并/);
  const open = await prepareDubPlan({
    source: {
      duration: 12,
      analyze: async () => ({ duration: 12, fingerprint: 'open-tail', spans: [{ start: 0, end: 12, kind: 'speech', speaker: 'A' }] }),
      slice: async (start, seconds) => ({ start, end: start + seconds, seconds, blob }),
    },
    settings: sentenceSettings, signal: new AbortController().signal, deferUnfinished: true, windowed: true, skipBrief: true,
    transcribe: async () => [{ start: 0, end: 12, text: 'because I' }],
    chat: async () => { throw new Error('open tail must stay untranslated'); },
    cacheGet: async () => null, cacheSet: async () => true,
  });
  assert.equal(open.lines.length, 0);
  assert.equal(open.deferredCues.length, 1);
  assert.equal(open.deferredCues[0].src, 'because I');
  let compressed = 0;
  const tight = await prepareDubPlan({
    source: {
      duration: 1,
      subtitles: [{ id: 'short', start: 0, end: 1, src: 'A fairly long English remark for one second.', speaker: 'A' }],
      analyze: async () => ({ duration: 1, fingerprint: 'budget', spans: [{ start: 0, end: 1, kind: 'speech', speaker: 'A' }] }),
      slice: async () => ({ blob }),
    },
    settings: sentenceSettings, signal: new AbortController().signal, windowed: true, skipBrief: true,
    chat: async (_m, { messages }) => {
      const system = messages[0].content;
      const input = JSON.parse(messages[1].content);
      if (system.includes('压缩')) { compressed++; return '短'; }
      return JSON.stringify({ lines: [{ ids: [input.current[0].id], zh: '这是一段明显超过一秒预算的中文口播' }] });
    },
    cacheGet: async () => null, cacheSet: async () => true,
  });
  assert.equal(compressed, 0, 'real-time delivery must not add serial compression calls');
  assert.equal(tight.lines[0].zh, '这是一段明显超过一秒预算的中文口播', 'deliver confirmed translation without waiting for budget rewriting');
  console.log('PASS sentence context: merge, lookahead, cue fallback, unfinished tail, no realtime budget rewrite');
}

{
  const state = { ok: true, currentTime: 0, duration: 100, paused: true, userPaused: false, seekRevision: 0, readyState: 4, playbackRate: 1 };
  const commands = [];
  const abort = new AbortController();
  let asr = 0;
  const running = runPlannedInterpret({
    tabId: 1,
    settings: { ...settings, tts: { ...settings.tts, preparationMode: 'progressive', contextMode: 'sentence' } },
    signal: abort.signal,
    video: async (cmd, arg = {}) => {
      commands.push(cmd);
      if (cmd === 'control') state.paused = arg.action === 'pause';
      return { ...state };
    },
    openSource: async () => ({
      duration: 100,
      close: async () => {},
      subtitlesComplete: true,
      subtitles: [{ id: 'a', start: 37.1, end: 40, src: 'Hello there.' }],
      analyze: async () => new Promise(() => {}),
      slice: async (start, seconds) => ({ start, end: start + seconds, seconds, blob }),
    }),
    transcribe: async () => { asr++; return []; },
    chat: async () => new Promise(() => {}),
    cacheGet: async () => null,
    cacheSet: async () => true,
    voiceRef: async item => item,
    audioDuration: async () => 1,
    createAudio: () => ({ pause() {}, async play() {} }),
    synthesizeTts: async () => ({ blob }),
  });
  try {
    await until(() => !state.paused);
    assert(!commands.includes('silence'), 'quiet lead keeps the original audio on');
    assert.equal(asr, 0, 'a subtitle gap is not sent to ASR');
  } finally {
    abort.abort();
    await running.catch(error => { if (error?.name !== 'AbortError') throw error; });
  }
  console.log('PASS quiet subtitle lead plays original audio without waiting');
}

{
  const state = { ok: true, currentTime: 0, duration: 200, paused: true, userPaused: false, seekRevision: 0, readyState: 4, playbackRate: 1 };
  const commands = [], events = [];
  const abort = new AbortController();
  let analyzeResolve, sliceCalls = 0;
  const analyzePromise = new Promise(resolve => { analyzeResolve = resolve; });
  const subtitles = Array.from({ length: 40 }, (_, i) => ({
    id: `sub:${i}`, start: 37.136 + i * 4, end: 41.136 + i * 4,
    src: `Subtitle cue number ${i}`, speaker: null,
  }));
  const running = runPlannedInterpret({
    tabId: 1,
    settings: { ...settings, tts: { ...settings.tts, preparationMode: 'progressive', contextMode: 'sentence' } },
    signal: abort.signal,
    onEvent: e => events.push(e),
    video: async (cmd, arg = {}) => {
      commands.push(cmd);
      if (cmd === 'control') state.paused = arg.action === 'pause';
      return { ...state };
    },
    openSource: async () => ({
      duration: 200,
      close: async () => {},
      subtitles, subtitlesComplete: true,
      analyze: async () => analyzePromise,
      slice: async (start, seconds) => {
        sliceCalls++;
        return { start, end: start + seconds, seconds, blob };
      },
    }),
    chat: async (_, { messages }) => {
      const input = JSON.parse(messages[1].content);
      return input.current ? JSON.stringify({ lines: input.current.map(c => ({ ids: [c.id], zh: '本句翻译。' })) }) : '';
    },
    cacheGet: async () => null,
    cacheSet: async () => true,
    voiceRef: async () => null,
    audioDuration: async () => 1,
    createAudio: () => ({ pause() {}, async play() {} }),
    synthesizeTts: async () => ({ blob }),
  });
  try {
    await until(() => !state.paused);
    state.currentTime = 5;
    analyzeResolve({
      duration: 200,
      fingerprint: 'bg-diarization',
      background: false,
      spans: [
        { start: 0, end: 10, kind: 'music' },
        { start: 10, end: 37.136, kind: 'silence' },
        { start: 37.136, end: 200, kind: 'speech', speaker: 'A' },
      ],
    });
    for (let t = 6; t <= 36.5; t += 3) {
      state.currentTime = t;
      await sleep(15);
      assert(!state.paused, `video must not pause during quiet intro at t=${t}`);
    }
    await until(() => events.some(e => e.type === 'dub_segment'));
    assert(sliceCalls <= 50, `candidate reference search must be bounded, got ${sliceCalls} slices`);
  } finally {
    abort.abort();
    await running.catch(error => { if (error?.name !== 'AbortError') throw error; });
  }
  console.log('PASS quiet intro playback persists through background analyze and bounds reference search');
}
