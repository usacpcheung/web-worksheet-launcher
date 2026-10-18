import test from 'node:test';
import assert from 'node:assert/strict';
import { runOwnedSessionProbe } from './session-coordinator.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const ready=sub=>({ok:true,status:'ready',user:{sub}});
function setup() {
  let state={status:'ready',user:{sub:'a'}};const writes=[];
  return {get state(){return state;},set state(value){state=value;},writes,
    run:(probe,isCurrent=()=>true)=>runOwnedSessionProbe({readState:()=>state,
      writeState:value=>{state=value;writes.push(value);},probe,presentError:()=> 'localized error',isCurrent})};
}
test('same-account valid actions continue in both completion orders without stale writes',async()=>{
  for(const first of [0,1]){
    const app=setup(),a=deferred(),b=deferred();
    const old=app.run(()=>a.promise),next=app.run(()=>b.promise);
    [a,b][first].resolve(ready('a'));await Promise.resolve();
    [a,b][1-first].resolve(ready('a'));
    assert.equal((await old).ok,true);assert.equal((await next).ok,true);
    assert.equal(app.writes.filter(s=>s.status==='ready').length,1);
  }
});
test('newer failure, account change and external expiry prevent obsolete success',async()=>{
  for(const replacement of [{status:'not_ready'}, {status:'ready',user:{sub:'b'}}]){
    const app=setup(),a=deferred();const pending=app.run(()=>a.promise);
    app.state=replacement;a.resolve(ready('a'));
    assert.equal((await pending).status,'superseded');assert.equal(app.state,replacement);
  }
});
test('canceled owner restores previous state, and pre-canceled action does no work',async()=>{
  const app=setup(),initial=app.state,a=deferred();let current=true;
  const pending=app.run(()=>a.promise,()=>current);current=false;a.resolve(ready('a'));
  assert.equal((await pending).status,'superseded');assert.equal(app.state,initial);
  assert.equal((await app.run(()=>{throw Error('must not run');},()=>false)).status,'superseded');
});
test('rejected probes settle waiters and leave recoverable state',async()=>{
  const app=setup(),a=deferred();const old=app.run(()=>a.promise);
  const next=app.run(async()=>{throw Error('transport');});
  a.resolve(ready('a'));assert.equal((await next).status,'error');
  assert.equal((await old).status,'superseded');assert.equal(app.state.status,'error');
  assert.equal((await app.run(async()=>ready('a'))).ok,true);
});
test('separate adapters never share state or in-flight decisions',async()=>{
  const a=setup(),b=setup();await a.run(async()=>ready('other'));
  assert.equal(b.state.user.sub,'a');assert.equal(b.writes.length,0);
});
