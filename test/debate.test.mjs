import test from 'node:test';
import assert from 'node:assert/strict';
import { debate } from '../dist/debate.js';

const input = {
  facts_text: 'holders 120\nadmin_keys 1\nliquidity_lock_days 30\nsource_count 3',
  level: 'elevated', points: 42, flag_ids: ['ADMIN_KEY', 'LOCK'], unknown: ['owner history not supplied'],
};
const goodSound = 'The facts list 120 holders and 3 sources. One admin key remains a concentrated control point.';
const goodFragile = 'The facts list 1 admin key and a 30 day liquidity lock. The available extract does not resolve key custody.';
const goodReview = JSON.stringify({text:'The single admin key is a relevant control concentration. The measured extract does not resolve custody.',weight:['ADMIN_KEY','NOT_A_FLAG'],unknown:['owner history not supplied'],tension:'Holder count and key concentration describe different risks.'});
function depsFor(contents, more={}) {
  const roles=[];const costs={sound:0.01,fragile:0.02,reviewer:0.03};
  return {roles, ...more, route:async args=>{roles.push(args.payload.role);const val=contents[args.payload.role];return {content:typeof val==='function'?await val(args):val,model:`test-${args.payload.role}`,cost_usd:costs[args.payload.role]};}};
}

// A1: two advocates run in parallel, then the reviewer sees both outputs and the original facts.
test('A1: parallel advocates precede reviewer with factual context', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const calls=[];
  const deps={mode:'on',route:async args=>{calls.push(args);if(args.payload.role!=='reviewer')await gate;return {content:args.payload.role==='sound'?goodSound:args.payload.role==='fragile'?goodFragile:goodReview,cost_usd:0.01};}};
  const pending=debate(input,deps);await new Promise(r=>setTimeout(r,10));assert.equal(calls.length,2);release();
  const result=await pending;assert.deepEqual(calls.map(x=>x.payload.role),['sound','fragile','reviewer']);
  assert.match(calls[2].payload.prompt,/Measured facts:/);assert.match(calls[2].payload.prompt,/Sound case:/);assert.equal(result.status,'ok');assert.equal(result.shown,true);
  for(const a of calls){assert.equal(a.agent_id,'golden-kog');assert.equal(a.constitutional_flag,false);}
});

// A2: an unsupported numeric claim in one advocate is replaced, while a reviewer numeric claim rejects everything.
test('A2: unsupported numeric facts trigger fallback or reviewer rejection', async () => {
  let d=depsFor({sound:'This says 999 holders.',fragile:goodFragile,reviewer:goodReview},{mode:'on'});
  let x=await debate(input,d);assert.equal(x.sound,'No case could be written from the measured facts.');assert.ok(x.rejected.some(s=>s.includes('sound: number not in facts_text')));assert.equal(x.status,'ok');
  d=depsFor({sound:goodSound,fragile:goodFragile,reviewer:JSON.stringify({text:'There are 999 holders.',weight:[],unknown:[]})},{mode:'on'});
  x=await debate(input,d);assert.equal(x.status,'rejected');assert.equal(x.sound,'');assert.ok(x.rejected.some(s=>s.includes('reviewer: number not in facts_text')));
});

// A3: refused language, long dashes, Unicode digits, word limits and caller guards reject.
test('A3: all content guard failures are enforced', async () => {
  const badCases=[
    ['This is bullish.','contains refused trading language'],
    ['A measured fact — and a second clause.','contains a dash character'],
    ['A measured fact with a hyphenated-term.','contains a dash character'],
    ['The ١ holders remain unresolved.','contains a non-Latin digit'],
    [Array.from({length:181},()=> 'word').join(' '),'word limit exceeded'],
  ];
  for(const [bad,why] of badCases){const d=depsFor({sound:bad,fragile:goodFragile,reviewer:goodReview},{mode:'on'});const x=await debate(input,d);assert.equal(x.sound,'No case could be written from the measured facts.');assert.ok(x.rejected.some(s=>s.includes(why)),why);}
  const d=depsFor({sound:goodSound,fragile:goodFragile,reviewer:goodReview},{mode:'on',check:t=>t===goodSound?['synthetic caller flag']:[]});const x=await debate(input,d);assert.ok(x.rejected.some(s=>s.includes('caller guard: synthetic caller flag')));
});

// A4: reviewer JSON parsing and weight filtering.
test('A4: reviewer JSON must parse and weight keeps known flag ids only', async () => {
  const good=depsFor({sound:goodSound,fragile:goodFragile,reviewer:goodReview},{mode:'on'});let x=await debate(input,good);assert.deepEqual(x.weight,['ADMIN_KEY']);assert.equal(x.usd,0.06);assert.deepEqual(x.models,{sound:'test-sound',fragile:'test-fragile',reviewer:'test-reviewer'});
  const bad=depsFor({sound:goodSound,fragile:goodFragile,reviewer:'not json'},{mode:'on'});x=await debate(input,bad);assert.equal(x.status,'rejected');assert.deepEqual([x.sound,x.fragile,x.reviewer],['','','']);assert.ok(x.rejected.includes('reviewer: unparseable JSON'));
});

// A5: hung calls return a timeout result rather than throwing.
test('A5: advocate and reviewer timeout are bounded and do not throw', async () => {
  let x=await debate(input,{mode:'on',timeoutMs:8,route:()=>new Promise(()=>{})});assert.equal(x.status,'timeout');assert.equal(x.shown,false);
  let n=0;x=await debate(input,{mode:'on',timeoutMs:10,route:async a=>{n++;if(a.payload.role==='reviewer')return new Promise(()=>{});return {content:a.payload.role==='sound'?goodSound:goodFragile};}});assert.equal(x.status,'timeout');assert.ok(x.rejected.some(s=>s.includes('reviewer call timed out')));
});

// A6: off is network-free; shadow is logged but not shown; on may be shown; costs sum.
test('A6: mode off avoids calls, shadow logs and on displays', async () => {
  let n=0;let x=await debate(input,{mode:'off',route:async()=>{n++;throw Error('must not run');}});assert.equal(x.status,'off');assert.equal(n,0);
  const logs=[];x=await debate(input,depsFor({sound:goodSound,fragile:goodFragile,reviewer:goodReview},{mode:'shadow',log:r=>logs.push(r)}));assert.equal(x.shown,false);assert.equal(logs.length,1);assert.equal(x.usd,0.06);
  x=await debate(input,depsFor({sound:goodSound,fragile:goodFragile,reviewer:goodReview},{mode:'on'}));assert.equal(x.shown,true);
});

// A7: input is factual source text; invalid input fails closed, even in on mode.
test('A7: README example and input-shape rejection are explicit', async () => {
  const x=await debate({...input,facts_text:'  '},{mode:'on',route:async()=>{throw Error('must not route');}});assert.equal(x.status,'rejected');assert.ok(x.rejected.includes('invalid input shape'));
});
