import test from 'node:test';
import assert from 'node:assert/strict';
import { runUploadRecoveryFlow } from './upload-recovery-flow.js';
const kinds = {
 'worksheet-draft': ['DRAFT_NAME_CONFLICT','DRAFT_SLOT_LIMIT_REACHED'],
 'worksheet-attempt': ['ATTEMPT_NAME_CONFLICT','ATTEMPT_SLOT_LIMIT_REACHED'],
 'roleplayscene-draft': ['ROLEPLAYSCENE_DRAFT_NAME_CONFLICT','ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED'],
};
const failure = code => ({ok:false,error:{code}});
for (const [resource,[conflict,slot]] of Object.entries(kinds)) {
 test(`${resource}: repeated recovery preserves action and waits for each user decision`, async()=>{
  const results=[failure(conflict),failure(slot),failure(slot),failure(conflict),{ok:true}];
  const events=[], choices=['copy','replace'];
  const result=await runUploadRecoveryFlow({resource,
   submit:async action=>{events.push(`submit:${action}`);return results.shift();},
   chooseConflict:async()=>{const choice=choices.shift();events.push(choice);return choice;},
   recoverSlots:async()=>{events.push('confirmed-delete');return {deleted:true};},
  });
  assert.equal(result.status,'completed');assert.equal(result.result.ok,true);
  assert.deepEqual(events,['submit:','copy','submit:copy','confirmed-delete','submit:copy','confirmed-delete','submit:copy','replace','submit:replace']);
 });
 for(const stage of ['submit','conflict','slots']) for(const stop of ['stale','abort']) {
  test(`${resource}: ${stop} during ${stage} cannot continue recovery`,async()=>{
   let current=true,posts=0,decisions=0;const controller=new AbortController();
   const halt=()=>{if(stop==='stale')current=false;else controller.abort();};
   const result=await runUploadRecoveryFlow({resource,isCurrent:()=>current,signal:controller.signal,
    submit:async()=>{posts++;if(stage==='submit')halt();return failure(stage==='slots'?slot:conflict);},
    chooseConflict:async()=>{decisions++;halt();return 'copy';},
    recoverSlots:async()=>{decisions++;halt();return {deleted:true};},
   });
   assert.equal(posts,1);assert.equal(decisions,stage==='submit'?0:1);
   assert.equal(result.status,stop==='stale'?'stale':'canceled');
  });
 }
 for(const deleted of [false,undefined,'true']) test(`${resource}: only confirmed deletion allows retry (${deleted})`,async()=>{
  let posts=0;
  const result=await runUploadRecoveryFlow({resource,submit:async()=>{posts++;return failure(slot);},recoverSlots:async()=>({deleted})});
  assert.equal(posts,1);assert.equal(result.status,'canceled');
 });
 for(const code of ['NETWORK_ERROR','UPLOAD_TIMEOUT','ABORTED','AUTH_REQUIRED']) test(`${resource}: ${code} is terminal`,async()=>{
  let posts=0;const original=failure(code);
  const result=await runUploadRecoveryFlow({resource,submit:async()=>{posts++;return original;},chooseConflict:()=>assert.fail('unexpected dialog'),recoverSlots:()=>assert.fail('unexpected dialog')});
  assert.equal(posts,1);assert.equal(result.result,original);
 });
 test(`${resource}: auth metadata prevents conflict recovery`,async()=>{
  const original={ok:false,error:{code:conflict,status:401}};
  const result=await runUploadRecoveryFlow({resource,initialResult:original,submit:()=>assert.fail('unexpected retry'),chooseConflict:()=>assert.fail('unexpected dialog')});
  assert.equal(result.result,original);
 });
}
test('initial success is not resubmitted; cancellation preserves confirmed success',async()=>{
 const controller=new AbortController(); const saved={ok:true,data:{id:'saved'}};
 const result=await runUploadRecoveryFlow({resource:'worksheet-draft',signal:controller.signal,submit:async()=>{controller.abort();return saved;}});
 assert.equal(result.status,'completed');assert.equal(result.result,saved);
 await runUploadRecoveryFlow({resource:'worksheet-draft',initialResult:saved,submit:()=>assert.fail('unexpected retry')});
});
