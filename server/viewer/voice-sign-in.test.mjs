import test from 'node:test';
import assert from 'node:assert/strict';
import { requestViewerVoiceSignIn } from './voice-sign-in.js';

function fixture(record = { phase:'preflight', mode:'voice', code:'AUTH_REQUIRED', text:'' }) {
  record = { code:'AUTH_REQUIRED', ...record };
  let logins = 0;
  const state = { localAttemptId:'attempt-a', viewerPayload:{}, status:'in_progress',
    answers:{ q:{ value:'Keep my answer' } }, voiceRecovery:{ q:record } };
  const session = { state, beginServerSignIn:async () => { logins++; return { ok:true }; } };
  return { session, record, logins:() => logins };
}
const options = { blockId:'q', translate:key=>key };

test('cancel preserves the answer and recovery without opening login', async () => {
  const f=fixture(); const before=JSON.stringify(f.session.state);
  const result=await requestViewerVoiceSignIn(f.session,{...options,prompt:async p=>{
    assert.equal(p.title,'viewer.voice.signInTitleVoice');
    assert.equal(p.description,'viewer.voice.signInPromptVoice');
    return false;
  }});
  assert.equal(result,false); assert.equal(f.logins(),0);
  assert.equal(JSON.stringify(f.session.state),before);
});
test('accept signs in once, without replaying recording or rewriting', async () => {
  const f=fixture(); const before=JSON.stringify(f.session.state);
  assert.deepEqual(await requestViewerVoiceSignIn(f.session,{...options,prompt:async()=>true}),{ok:true});
  assert.equal(f.logins(),1); assert.equal(JSON.stringify(f.session.state),before);
});
test('concurrent prompts share one dialog and permit a fresh prompt after cancellation', async () => {
  const f=fixture(); let resolve, count=0;
  const prompt=()=>{count++;return new Promise(r=>{resolve=r});};
  const a=requestViewerVoiceSignIn(f.session,{...options,prompt});
  const b=requestViewerVoiceSignIn(f.session,{...options,prompt});
  assert.equal(a,b); await Promise.resolve(); assert.equal(count,1);
  resolve(false); await a;
  await requestViewerVoiceSignIn(f.session,{...options,prompt:async()=>true});
  assert.equal(f.logins(),1);
});
for (const [name, invalidate] of Object.entries({
  attempt:f=>{f.session.state.localAttemptId='other';},
  payload:f=>{f.session.state.viewerPayload={};},
  completed:f=>{f.session.state.status='completed';},
  finalizing:f=>{f.session.state.isFinalizing=true;},
  recovery:f=>{f.session.state.voiceRecovery.q={...f.record};},
  discarded:f=>{delete f.session.state.voiceRecovery.q;},
})) test(`stale ${name} cannot start login after confirmation`,async()=>{
  const f=fixture();
  await requestViewerVoiceSignIn(f.session,{...options,prompt:async p=>{
    assert.equal(p.isCurrent(),true);invalidate(f);assert.equal(p.isCurrent(),false);return true;
  }});
  assert.equal(f.logins(),0);
});
test('aborted and detached owners cannot prompt or sign in',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await requestViewerVoiceSignIn(f.session,{...options,signal:controller.signal,prompt:()=>assert.fail('stale prompt')});
  await requestViewerVoiceSignIn(f.session,{...options,isCurrent:()=>false,prompt:()=>assert.fail('stale prompt')});
  assert.equal(f.logins(),0);
});
for(const record of [{phase:'text',text:'Retain transcript',mode:'voice'}, {phase:'capture',text:'',mode:'voice'}, {phase:'preflight',text:'',mode:'rewrite'}])
 test(`accurate sign-in copy for ${record.mode}/${record.phase}`,async()=>{
  const f=fixture(record);
  await requestViewerVoiceSignIn(f.session,{...options,prompt:async p=>{
    assert.equal(p.description,record.phase==='preflight'?'viewer.voice.signInPromptRewrite':'viewer.voice.signInPromptRecovery');return false;
  }});
  assert.equal(f.session.state.voiceRecovery.q,f.record);
 });

test('discarded or non-auth recovery does not open a sign-in dialog',async()=>{
  for(const code of ['NETWORK_ERROR','FORBIDDEN',undefined]){
    const f=fixture({code,phase:'preflight'});
    if(code===undefined)delete f.session.state.voiceRecovery.q;
    await requestViewerVoiceSignIn(f.session,{...options,prompt:()=>assert.fail('not an auth failure')});
    assert.equal(f.logins(),0);
  }
});
test('aborting while the dialog is open prevents an accepted late result',async()=>{
  const f=fixture(),controller=new AbortController();
  await requestViewerVoiceSignIn(f.session,{...options,signal:controller.signal,prompt:async p=>{
    controller.abort();assert.equal(p.isCurrent(),false);return true;
  }});assert.equal(f.logins(),0);
});
