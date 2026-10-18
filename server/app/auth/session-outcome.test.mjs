import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySessionFailure as classify } from './session-outcome.js';

test('new policy distinguishes permission, authentication, transport and cancellation', () => {
  for (const [error, expected] of [
    [{code:'FORBIDDEN',status:403,requiresSignIn:true},'permission_denied'],
    [{code:'PERMISSION_DENIED',status:403},'permission_denied'],
    [{code:'AUTH_REQUIRED',status:403,requiresSignIn:true},'authentication_required'],
    [{code:'AUTH_REQUIRED',status:401},'authentication_required'],
    [{code:'NETWORK_ERROR',status:503,requiresSignIn:true},'unavailable'],
    [{code:'SESSION_PROBE_TIMEOUT'},'unavailable'],
    [{code:'SESSION_PROBE_CANCELLED'},'cancelled'],
    [{status:403},'permission_denied'],
    [{message:'Sign in now'},'unavailable'],
  ]) assert.equal(classify({ok:false,error}),expected);
  assert.equal(classify({ok:false,skipped:true}),'superseded');
  assert.equal(classify({ok:false,result:{ok:false,error:{code:'AUTH_REQUIRED'}}}),'authentication_required');
});

test('legacy readiness classification remains identical over status/code/flag combinations', () => {
  for (const status of [undefined,null,0,200,401,403,503,'401','403.0','error']) {
    for (const code of [undefined,'AUTH_REQUIRED','auth_required','FORBIDDEN','SESSION_EXPIRED','ABORTED']) {
      for (const requiresSignIn of [undefined,false,true]) {
        const error={status,code,requiresSignIn};
        const old=Boolean(requiresSignIn || Number(status)===401 || Number(status)===403 || String(code||'').toUpperCase()==='AUTH_REQUIRED');
        assert.equal(classify({error},{legacyAuthStatuses:true})==='authentication_required',old);
      }
    }
  }
});

test('classification is pure and does not inspect localized prose', () => {
  const error=Object.freeze({code:'FORBIDDEN',status:403,requiresSignIn:true,message:'任意文字'});
  assert.equal(classify(Object.freeze({ok:false,error})),'permission_denied');
  assert.equal(error.requiresSignIn,true);
});
