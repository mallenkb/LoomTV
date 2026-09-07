const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NativeSessionLease } = require('../src/components/VideoPlayer/engines/NativeSessionLease.ts');
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture(listener) {
  const starts = [], stops = [], states = [], errors = [];
  let receiver, unsubscriptions = 0;
  const port = {
    start(source, options) { const d = deferred(); starts.push({ ...d, source, options }); return d.promise; },
    async stop(id) { stops.push(id); },
    onState(fn) { receiver = fn; return () => { unsubscriptions++; }; },
  };
  const lease = new NativeSessionLease(port, listener || (s => states.push(s)), e => errors.push(e));
  return { lease, port, starts, stops, states, errors, emit: s => receiver(s), get unsubscriptions() { return unsubscriptions; } };
}
const accepted = id => ({ ok: true, sessionId: id, surface: 'composited-window' });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function dispatch(f, source='clip', options) { const p = f.lease.load(source, options); await settle(); return { p }; }
async function load(f, id) { const { p } = await dispatch(f, id); f.starts.at(-1).resolve(accepted(id)); await p; }

test('adopts the host session, source, options and actual surface', async () => {
  const f = fixture(); const { p } = await dispatch(f, '/movie.mkv', { volume: .7 });
  assert.equal(f.starts[0].source, '/movie.mkv'); assert.deepEqual(f.starts[0].options, { volume: .7 });
  f.starts[0].resolve(accepted('one')); assert.equal(await p, true);
  assert.equal(f.lease.sessionId, 'one'); assert.equal(f.lease.surface, 'composited-window');
  await f.lease.dispose(); assert.deepEqual(f.stops, ['one']);
});
test('filters unrelated and empty session IDs', async () => {
  const f = fixture(); await load(f, 'one');
  f.emit({sessionId:'old'}); f.emit({sessionId:''}); f.emit({sessionId:'one',status:'ready'});
  assert.deepEqual(f.states,[{sessionId:'one',status:'ready'}]); await f.lease.dispose();
});
test('merges early state patches without losing tracks', async () => {
  const f=fixture(); const {p}=await dispatch(f);
  f.emit({sessionId:'one',tracks:[1],status:'loading'}); f.emit({sessionId:'one',status:'ready',position:10});
  f.starts[0].resolve(accepted('one')); await p;
  assert.deepEqual(f.states,[{sessionId:'one',tracks:[1],status:'ready',position:10}]); await f.lease.dispose();
});
test('early event storage is bounded even during a flood of unrelated IDs', async () => {
  const f=fixture(); const {p}=await dispatch(f);
  for(let i=0;i<10000;i++) f.emit({sessionId:`other-${i}`,position:i});
  assert.equal(f.lease.early.size,8); f.starts[0].resolve(accepted('other-9999')); await p;
  assert.equal(f.states.length,1); assert.equal(f.lease.early.size,0); await f.lease.dispose();
});
test('ignores events when no start or active session exists', async () => {
  const f=fixture(); f.emit({sessionId:'rogue'}); assert.equal(f.lease.early.size,0); await f.lease.dispose();
});
test('dispose during a dispatched start reclaims its late session', async () => {
  const f=fixture(); const {p}=await dispatch(f); const d=f.lease.dispose();
  f.starts[0].resolve(accepted('late')); assert.equal(await p,false); await d;
  assert.equal(f.lease.sessionId,null); assert.deepEqual(f.stops,['late']); assert.equal(f.states.length,0);
});
test('dispose waits for a dispatched start to settle and be stopped', async () => {
  const f=fixture(); const {p}=await dispatch(f); let done=false;
  const d=f.lease.dispose().then(()=>{done=true;}); await settle(); assert.equal(done,false);
  f.starts[0].resolve(accepted('late')); await p; await d; assert.equal(done,true);
});
test('dispose before a queued start does not launch a native player', async () => {
  const f=fixture(); const p=f.lease.load('one'); const d=f.lease.dispose();
  assert.equal(await p,false); await d; assert.equal(f.starts.length,0);
});
test('new loads cannot overtake an in-flight native start', async () => {
  const f=fixture(); const {p:a}=await dispatch(f,'a'); const b=f.lease.load('b'); await settle();
  assert.equal(f.starts.length,1); f.starts[0].resolve(accepted('a')); assert.equal(await a,false); await settle();
  assert.deepEqual(f.stops,['a']); assert.equal(f.starts.length,2);
  f.starts[1].resolve(accepted('b')); assert.equal(await b,true); await f.lease.dispose();
});
test('superseded queued loads never reach the host', async () => {
  const f=fixture(); const {p:a}=await dispatch(f,'a'); const b=f.lease.load('b'), c=f.lease.load('c');
  f.starts[0].resolve(accepted('a')); await a; assert.equal(await b,false); await settle();
  assert.deepEqual(f.starts.map(s=>s.source),['a','c']);
  f.starts[1].resolve(accepted('c')); await c; await f.lease.dispose();
});
test('replacement waits for the active session stop', async () => {
  const f=fixture(); await load(f,'a'); const stop=deferred(); f.port.stop=id=>{f.stops.push(id);return stop.promise;};
  const b=f.lease.load('b'); await settle(); assert.equal(f.starts.length,1);
  stop.resolve(); await settle(); f.starts[1].resolve(accepted('b')); await b; await f.lease.dispose();
});
test('a third load cannot bypass an outstanding stop', async () => {
  const f=fixture(); await load(f,'a'); const stop=deferred(); f.port.stop=id=>{f.stops.push(id);return stop.promise;};
  const b=f.lease.load('b'); await settle(); const c=f.lease.load('c'); await settle(); assert.equal(f.starts.length,1);
  stop.resolve(); assert.equal(await b,false); await settle(); assert.equal(f.starts[1].source,'c');
  f.starts[1].resolve(accepted('c')); await c; await f.lease.dispose();
});
test('dispose during a prior stop does not start its queued replacement', async () => {
  const f=fixture(); await load(f,'a'); const stop=deferred(); f.port.stop=()=>stop.promise;
  const b=f.lease.load('b'); await settle(); const d=f.lease.dispose(); stop.resolve();
  assert.equal(await b,false); await d; assert.equal(f.starts.length,1);
});
test('partially allocated failed starts are stopped', async () => {
  const f=fixture(); const {p}=await dispatch(f); f.starts[0].resolve({ok:false,sessionId:'partial',error:'renderer failed'});
  await assert.rejects(p,/renderer failed/); assert.deepEqual(f.stops,['partial']); await f.lease.dispose();
});
test('failure without an ID does not invent a stop', async () => {
  const f=fixture(); const {p}=await dispatch(f); f.starts[0].resolve({ok:false,error:'missing library'});
  await assert.rejects(p,/missing library/); assert.deepEqual(f.stops,[]); await f.lease.dispose();
});
test('success without an ID is rejected', async () => {
  const f=fixture(); const {p}=await dispatch(f); f.starts[0].resolve({ok:true});
  await assert.rejects(p,/could not start/); await f.lease.dispose();
});
test('transport rejection reaches the load caller', async () => {
  const f=fixture(); const {p}=await dispatch(f); f.starts[0].reject(new Error('IPC disconnected'));
  await assert.rejects(p,/IPC disconnected/); await f.lease.dispose();
});
test('transport rejection after dispose is observed and disposal completes', async () => {
  const f=fixture(); const {p}=await dispatch(f); const d=f.lease.dispose(); f.starts[0].reject(new Error('unavailable'));
  await assert.rejects(p,/unavailable/); await d;
});
test('dispose is idempotent; a disposed lease cannot load again', async () => {
  const f=fixture(); const a=f.lease.dispose(),b=f.lease.dispose(); assert.equal(a,b); await a;
  assert.equal(f.unsubscriptions,1); await assert.rejects(f.lease.load('new'),/disposed/);
});
test('no state escapes after disposal even if the host retained the callback', async () => {
  const f=fixture(); await load(f,'a'); await f.lease.dispose(); f.emit({sessionId:'a'}); assert.equal(f.states.length,0);
});
test('a failed stop is reported and retried on disposal', async () => {
  const f=fixture(); await load(f,'a'); let count=0;
  f.port.stop=async id=>{f.stops.push(id);if(++count===1)throw new Error('temporary');};
  await f.lease.dispose(); assert.deepEqual(f.stops,['a','a']); assert.equal(f.errors.length,1);
});
test('persistent cleanup failure rejects disposal', async () => {
  const f=fixture(); await load(f,'a'); f.port.stop=async()=>{throw new Error('stop failed');};
  await assert.rejects(f.lease.dispose(),/cleanup failed/); assert.equal(f.errors.length,2);
});
test('failed old-session cleanup prevents any new host start', async () => {
  const f=fixture(); await load(f,'a'); f.port.stop=async()=>{throw new Error('stop failed');};
  await assert.rejects(f.lease.load('b'),/stop failed/); await assert.rejects(f.lease.load('c'),/cleanup failed/);
  assert.equal(f.starts.length,1); await assert.rejects(f.lease.dispose(),/cleanup failed/);
});
test('listener exceptions do not lose the native handle', async () => {
  const f=fixture(()=>{throw new Error('UI failed');}); const {p}=await dispatch(f);
  f.emit({sessionId:'one',status:'ready'}); f.starts[0].resolve(accepted('one')); assert.equal(await p,true);
  assert.equal(f.errors.length,1); await f.lease.dispose(); assert.deepEqual(f.stops,['one']);
});
test('64 queued loads are cancelled without starting 64 native players', async () => {
  const f=fixture(); const {p}=await dispatch(f,'first');
  const rest=Array.from({length:64},(_,i)=>f.lease.load(String(i))); const d=f.lease.dispose();
  f.starts[0].resolve(accepted('first')); assert.equal(await p,false);
  assert.ok((await Promise.all(rest)).every(v=>v===false)); await d;
  assert.equal(f.starts.length,1); assert.deepEqual(f.stops,['first']);
});
test('a failed start does not poison the queue when cleanup succeeded', async () => {
  const f=fixture(); const {p}=await dispatch(f); f.starts[0].reject(new Error('missing runtime')); await assert.rejects(p);
  await load(f,'retry'); assert.equal(f.lease.sessionId,'retry'); await f.lease.dispose();
});
test('1000 load/dispose cycles leave no subscriptions, session IDs or retained events', async () => {
  for(let i=0;i<1000;i++) {
    const f=fixture(); const {p}=await dispatch(f);
    if(i%2) {const d=f.lease.dispose();f.starts[0].resolve(accepted(`id-${i}`));await p;await d;}
    else {f.starts[0].resolve(accepted(`id-${i}`));await p;await f.lease.dispose();}
    assert.equal(f.lease.sessionId,null); assert.equal(f.unsubscriptions,1); assert.equal(f.stops.length,1);
    assert.equal(f.lease.failedStops.size,0); assert.equal(f.lease.early.size,0);
  }
});
test('state from the previous generation is ignored immediately on load request', async () => {
  const f=fixture(); await load(f,'a'); const b=f.lease.load('b');
  assert.equal(f.lease.sessionId,null); f.emit({sessionId:'a',status:'ended'}); assert.equal(f.states.length,0);
  await settle(); f.starts[1].resolve(accepted('b')); await b; await f.lease.dispose();
});
test('a listener disposing during adoption cannot resurrect the session', async () => {
  let f, disposal; f=fixture(()=>{disposal=f.lease.dispose();}); const {p}=await dispatch(f);
  f.emit({sessionId:'a',status:'ready'}); f.starts[0].resolve(accepted('a'));
  assert.equal(await p,false); await disposal; assert.deepEqual(f.stops,['a']);
});
