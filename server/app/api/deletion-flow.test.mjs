import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeletionFlow, classifyDeletion } from './deletion-flow.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const phase of ['confirm','preflight','remove','refresh']) {
  for (const stale of [false,true]) {
    test(`reservation and ownership during ${phase}, stale=${stale}`, async () => {
      const gate=deferred(), pending=new Set(); let current=true, removes=0, refreshes=0;
      const options={pending,key:'draft:one',isCurrent:()=>current,
        confirm:async()=>phase==='confirm'?gate.promise:true,
        preflight:async()=>phase==='preflight'?gate.promise:{ok:true},
        remove:async()=>{removes++;return phase==='remove'?gate.promise:{ok:true};},
        refresh:async()=>{refreshes++;return phase==='refresh'?gate.promise:{ok:true};}};
      const first=runDeletionFlow(options); await tick();
      assert.equal((await runDeletionFlow(options)).deletionStatus,'busy');
      const independent=await runDeletionFlow({pending,key:'attempt:one',remove:async()=>({ok:true})});
      assert.equal(independent.ok,true);
      if(stale) current=false;
      gate.resolve(phase==='confirm'?true:{ok:true});
      const result=await first;
      assert.equal(result.deletionStatus,stale && ['confirm','preflight'].includes(phase)?'stale':'confirmed');
      assert.equal(removes,stale && ['confirm','preflight'].includes(phase)?0:1);
      assert.equal(refreshes,stale && phase!=='refresh'?0:1);
      assert.equal(result.refreshStatus,stale?(phase==='refresh'?'superseded':'skipped'):'succeeded');
      assert.equal(pending.size,0);
    });
  }
  test(`exception during ${phase} releases the reservation and preserves confirmed deletion`, async () => {
    const pending=new Set(); let removes=0;
    const fail=async()=>{throw Error('fixture');};
    const result=await runDeletionFlow({pending,key:'one',
      confirm:phase==='confirm'?fail:async()=>true,
      preflight:phase==='preflight'?fail:async()=>({ok:true}),
      remove:async()=>{removes++;return phase==='remove'?fail():{ok:true};},
      refresh:phase==='refresh'?fail:async()=>({ok:true})});
    assert.equal(result.deletionStatus,['confirm','preflight'].includes(phase)?'preflight_failed':phase==='remove'?'uncertain':'confirmed');
    assert.equal(result.ok,phase==='refresh');
    assert.equal(pending.size,0);
    assert.equal(removes,['confirm','preflight'].includes(phase)?0:1);
  });
}
for (const choice of [false,null,undefined,'delete',{}]) {
  test(`confirmation must explicitly return true (${JSON.stringify(choice)})`,async()=>{
    let removes=0; const pending=new Set();
    const result=await runDeletionFlow({pending,key:'one',confirm:async()=>choice,remove:async()=>{removes++;}});
    assert.equal(result.deletionStatus,'canceled'); assert.equal(removes,0); assert.equal(pending.size,0);
  });
}
for (const result of [
  {ok:false,error:{code:'NETWORK_ERROR'}}, {ok:false,error:{code:'ABORTED',status:200}},
  {ok:false,error:{code:'INVALID_JSON_RESPONSE',status:200}}, {ok:false,error:{code:'INTERNAL_ERROR',status:500}},
  undefined,
]) {
  test(`ambiguous DELETE never retries or refreshes: ${JSON.stringify(result)}`,async()=>{
    let calls=0,refreshes=0;
    const outcome=await runDeletionFlow({pending:new Set(),key:'one',remove:async()=>{calls++;return result;},refresh:async()=>{refreshes++;}});
    assert.equal(outcome.deletionStatus,'uncertain'); assert.equal(outcome.error.code,'DELETE_OUTCOME_UNCERTAIN');
    assert.equal(calls,1); assert.equal(refreshes,0); assert.equal(outcome.deleteResult,result);
  });
}
for (const status of [401,403,404,409,429]) {
  test(`explicit HTTP ${status} rejection is not an uncertain mutation`,()=>{
    assert.equal(classifyDeletion({ok:false,error:{code:'NETWORK_ERROR',status}}),'rejected');
  });
}
test('authentication refusal never deletes and keeps the original error',async()=>{
  const failure={ok:false,error:{code:'AUTH_REQUIRED'}};let calls=0;
  const result=await runDeletionFlow({pending:new Set(),key:'one',preflight:async()=>({ok:false,result:failure}),remove:()=>{calls++;}});
  assert.equal(result.deletionStatus,'preflight_failed'); assert.equal(result.error,failure.error); assert.equal(calls,0);
});
for (const refreshResult of [{ok:false,error:{code:'NETWORK_ERROR'}},{ok:false,status:'superseded'},{ok:false,status:'stale_response'}]) {
  test(`confirmed deletion remains successful after ${JSON.stringify(refreshResult)}`,async()=>{
    const result=await runDeletionFlow({pending:new Set(),key:'one',remove:async()=>({ok:true,data:{deleted:true}}),refresh:async()=>refreshResult});
    assert.equal(result.ok,true); assert.equal(result.deletionStatus,'confirmed');
    assert.equal(result.refreshStatus,refreshResult.status?'superseded':'failed');
    assert.equal(result.refreshResult,refreshResult);
  });
}
