import test from 'node:test';
import assert from 'node:assert/strict';
import { requestVoiceSignIn } from './voice-sign-in.js';

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
  const result=await requestVoiceSignIn(f.session,{...options,prompt:async p=>{
    assert.equal(p.title,'viewer.voice.signInTitleVoice');
    assert.equal(p.description,'viewer.voice.signInPromptVoice');
    return false;
  }});
  assert.equal(result,false); assert.equal(f.logins(),0);
  assert.equal(JSON.stringify(f.session.state),before);
});
test('accept signs in once, without replaying recording or rewriting', async () => {
  const f=fixture(); const before=JSON.stringify(f.session.state);
  assert.deepEqual(await requestVoiceSignIn(f.session,{...options,prompt:async()=>true}),{ok:true});
  assert.equal(f.logins(),1); assert.equal(JSON.stringify(f.session.state),before);
});
test('concurrent prompts share one dialog and permit a fresh prompt after cancellation', async () => {
  const f=fixture(); let resolve, count=0;
  const prompt=()=>{count++;return new Promise(r=>{resolve=r});};
  const a=requestVoiceSignIn(f.session,{...options,prompt});
  const b=requestVoiceSignIn(f.session,{...options,prompt});
  assert.equal(a,b); await Promise.resolve(); assert.equal(count,1);
  resolve(false); await a;
  await requestVoiceSignIn(f.session,{...options,prompt:async()=>true});
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
  await requestVoiceSignIn(f.session,{...options,prompt:async p=>{
    assert.equal(p.isCurrent(),true);invalidate(f);assert.equal(p.isCurrent(),false);return true;
  }});
  assert.equal(f.logins(),0);
});
test('aborted and detached owners cannot prompt or sign in',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await requestVoiceSignIn(f.session,{...options,signal:controller.signal,prompt:()=>assert.fail('stale prompt')});
  await requestVoiceSignIn(f.session,{...options,isCurrent:()=>false,prompt:()=>assert.fail('stale prompt')});
  assert.equal(f.logins(),0);
});
for(const record of [{phase:'text',text:'Retain transcript',mode:'voice'}, {phase:'capture',text:'',mode:'voice'}, {phase:'preflight',text:'',mode:'rewrite'}])
 test(`accurate sign-in copy for ${record.mode}/${record.phase}`,async()=>{
  const f=fixture(record);
  await requestVoiceSignIn(f.session,{...options,prompt:async p=>{
    assert.equal(p.description,record.phase==='preflight'?'viewer.voice.signInPromptRewrite':'viewer.voice.signInPromptRecovery');return false;
  }});
  assert.equal(f.session.state.voiceRecovery.q,f.record);
 });

test('discarded or non-auth recovery does not open a sign-in dialog',async()=>{
  for(const code of ['NETWORK_ERROR','FORBIDDEN',undefined]){
    const f=fixture({code,phase:'preflight'});
    if(code===undefined)delete f.session.state.voiceRecovery.q;
    await requestVoiceSignIn(f.session,{...options,prompt:()=>assert.fail('not an auth failure')});
    assert.equal(f.logins(),0);
  }
});
test('aborting while the dialog is open prevents an accepted late result',async()=>{
  const f=fixture(),controller=new AbortController();
  await requestVoiceSignIn(f.session,{...options,signal:controller.signal,prompt:async p=>{
    controller.abort();assert.equal(p.isCurrent(),false);return true;
  }});assert.equal(f.logins(),0);
});

for (const ok of [false, true]) test(`only verified login completes recovery (ok=${ok})`, async () => {
  const f = fixture({ phase:'text', text:'Keep transcript', mode:'voice' });
  const calls = [];
  f.session.voice = { settleAuthentication: (...args) => calls.push(args) };
  f.session.beginServerSignIn = async () => ({ ok });
  await requestVoiceSignIn(f.session, { ...options, confirm:false, prompt: () => assert.fail('inline login must not prompt again') });
  assert.equal(calls.length, ok ? 1 : 0);
  if (ok) assert.deepEqual(calls[0], ['q', f.record, true]);
});
test('late successful login cannot clear recovery from another attempt', async () => {
  const f=fixture();
  f.session.voice = { settleAuthentication: () => assert.fail('stale completion') };
  f.session.beginServerSignIn = async () => { f.session.state.localAttemptId='replacement'; return {ok:true}; };
  await requestVoiceSignIn(f.session, {...options, prompt:async()=>true});
});
