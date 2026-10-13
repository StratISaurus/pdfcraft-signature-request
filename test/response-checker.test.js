import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponseChecker } from '../src/response-checker.js';
function fixture(collect) {
  let visible=true,next=0;const timers=new Map(),results=[],errors=[];
  const checker=createResponseChecker({collect,onResult:value=>results.push(value),onError:error=>errors.push(error.message),visible:()=>visible,setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id),isTerminal:value=>value.done});
  return {checker,timers,results,errors,hide:()=>{visible=false;checker.visibilityChanged();},show:()=>{visible=true;checker.visibilityChanged();},tick:async()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);await fn();}};
}
test('automatic and manual checks share one in-flight collection and schedule only after completion',async()=>{
  let release,calls=0;const f=fixture(()=>{calls++;return new Promise(r=>release=r);});
  f.checker.start();assert.equal(f.timers.size,1);const tick=f.tick();
  const first=f.checker.check(),second=f.checker.check();await Promise.resolve();assert.equal(first,second);assert.equal(calls,1);assert.equal(f.timers.size,0);
  release({done:false});await tick;await first;assert.equal(f.results.length,1);assert.equal(f.timers.size,1);f.checker.stop();assert.equal(f.timers.size,0);
});
test('hidden sender schedules nothing; resume after show, never after terminal completion',async()=>{
  let calls=0;const f=fixture(async()=>({done:++calls===2}));f.checker.start();f.hide();assert.equal(f.timers.size,0);
  f.show();await f.tick();assert.equal(calls,1);f.hide();assert.equal(f.timers.size,0);f.show();await f.tick();assert.equal(f.timers.size,0);
  f.show();assert.equal(f.timers.size,0);await f.checker.check();assert.equal(calls,2);
});
test('error pauses automatic checks until explicit retry, including hide/show',async()=>{
  let calls=0;const f=fixture(async()=>{if(++calls===1)throw Error('offline');return {done:false};});f.checker.start();await f.tick();
  assert.deepEqual(f.errors,['offline']);assert.equal(f.timers.size,0);f.hide();f.show();assert.equal(f.timers.size,0);
  await f.checker.check();assert.equal(f.results.length,1);assert.equal(f.timers.size,1);
});
test('stopping during in-flight work discards the late result and never restarts',async()=>{
  let release;const f=fixture(()=>new Promise(r=>release=r));f.checker.start();const tick=f.tick();await Promise.resolve();f.checker.stop();release({done:false});await tick;
  assert.equal(f.results.length,0);assert.equal(f.timers.size,0);f.show();assert.equal(f.timers.size,0);
});
