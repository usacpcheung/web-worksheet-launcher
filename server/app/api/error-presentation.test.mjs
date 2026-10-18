import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveErrorPresentation, getApiErrorMessage, createErrorDetails } from './error-presentation.js';
import { setLocale } from '../i18n/index.js';
import en from '../i18n/locales/en.js';
import zh from '../i18n/locales/zh-Hant.js';

test('shared messages have parity and render in the selected locale without exposing raw diagnostics', () => {
 assert.deepEqual(Object.keys(en.apiErrors).sort(),Object.keys(zh.apiErrors).sort());
 for (const locale of ['en','zh-Hant']) {
  setLocale(locale,{persist:false});
  for(const operation of ['upload','publish','list','open','download','delete','session','audio','rewrite']) {
   const result = {ok:false,error:{code:'UNKNOWN_SERVICE_FAILURE',message:'<script>secret token</script>',details:{url:'secret'}}};
   const before=JSON.stringify(result);
   const message=getApiErrorMessage(result,operation,'bridge');
   assert.ok(message.length);assert.ok(!message.includes('secret'));assert.ok(!message.includes('apiErrors.'));
   if(locale==='zh-Hant') assert.match(message,/[\u3400-\u9fff]/);
   assert.equal(JSON.stringify(result),before);
  }
 }
 setLocale('en',{persist:false});
});
for(const [code,operation,key] of [
 ['ABORTED','upload','uploadCanceled'],['ABORTED','download','canceled'],
 ['NETWORK_ERROR','upload','uploadUncertain'],['NETWORK_ERROR','list','network'],
 ['DRAFT_REPLACE_TARGET_MISSING','upload','notFound'],['UPLOAD_OPERATION_MISMATCH','upload','operationMismatch'],
 ['INVALID_ATTEMPT_PACKAGE','upload','invalidPackage'],['VOICE_CHOICE_UNSUPPORTED','audio','voiceUnsupported'],
]) test(`${operation}/${code} maps by code without changing the response`,()=>{
 const result=Object.freeze({ok:false,error:Object.freeze({code,message:'raw upstream'})});
 assert.equal(resolveErrorPresentation(result,{operation}).key,`apiErrors.${key}`);
});
test('transient gateway response is not mislabeled as sign-in failure; HTTP auth is recognized',()=>{
 assert.equal(resolveErrorPresentation({error:{code:'UNEXPECTED_NON_JSON_RESPONSE',status:502,requiresSignIn:true}}).key,'apiErrors.invalidResponse');
 assert.equal(resolveErrorPresentation({error:{code:'UNKNOWN',status:401}}).key,'apiErrors.authRequired');
});
test('numeric parameters are validated and only safe diagnostics escape',()=>{
 for(const value of [null,undefined,-1,0,'<img>',{},Infinity]) {
  assert.equal(resolveErrorPresentation({error:{code:'DRAFT_SLOT_LIMIT_REACHED',details:{slotLimit:value}}}).key,'apiErrors.slots');
 }
 assert.deepEqual(resolveErrorPresentation({error:{code:'DRAFT_SLOT_LIMIT_REACHED',details:{slotLimit:3}}}).params,{limit:3});
 const result=resolveErrorPresentation({error:{code:'<script>',status:500,message:'password',details:{token:'secret'}}});
 assert.deepEqual(result.diagnostic,{source:'repository-api',status:500});
});
test('technical disclosure uses plain text and never raw error messages',()=>{
 const doc={createElement: tag=>({tag,children:[],append(...items){this.children.push(...items)}})};
 const details=createErrorDetails({error:{code:'UNKNOWN',status:502,message:'<img onerror=alert(1)>'}}, {}, doc);
 assert.equal(details.tag,'details');
 assert.equal(details.children[0].tag,'summary');
 assert.match(details.children[1].textContent,/UNKNOWN/);
 assert.ok(!details.children[1].textContent.includes('<img'));
});

test('bridge errors cannot acquire repository-domain meanings', () => {
  assert.equal(resolveErrorPresentation({ error: { code: 'DRAFT_NAME_CONFLICT' } }, {
    source: 'bridge', operation: 'audio',
  }).key, 'apiErrors.audioFailed');
  assert.equal(resolveErrorPresentation({ error: { code: 'VOICE_CHOICE_UNSUPPORTED' } }, {
    source: 'bridge', operation: 'audio',
  }).key, 'apiErrors.voiceUnsupported');
});

test('explicit permission denial and session timeout retain actionable meanings', () => {
  assert.equal(resolveErrorPresentation({ error: { code: 'FORBIDDEN', status: 403 } }).key, 'apiErrors.forbidden');
  assert.equal(resolveErrorPresentation({ error: { code: 'SESSION_EXPIRED' } }, { source: 'bridge' }).key, 'apiErrors.sessionExpired');
  assert.equal(resolveErrorPresentation({ error: { code: 'SESSION_PROBE_TIMEOUT' } }).key, 'apiErrors.sessionTimeout');
  assert.equal(resolveErrorPresentation({ result: { error: { code: 'AUTH_REQUIRED' } } }).key, 'apiErrors.authRequired');
});

test('unconfirmed uploads warn before retrying; definitive rejections keep their reason', () => {
  for (const error of [
    { code: 'UPSTREAM_FAILED', status: 502 },
    { code: 'INVALID_JSON_RESPONSE', status: 201 },
    { code: 'UNEXPECTED_NON_JSON_RESPONSE', status: 200 },
  ]) assert.equal(resolveErrorPresentation({ error }, { operation: 'upload' }).key, 'apiErrors.uploadUncertain');
  for (const [error, key] of [
    [{ code: 'AUTH_REQUIRED', status: 401 }, 'authRequired'],
    [{ code: 'UNKNOWN', status: 413 }, 'uploadTooLarge'],
    [{ code: 'UNKNOWN', status: 429 }, 'rateLimited'],
    [{ code: 'ABORTED', status: 502 }, 'uploadCanceled'],
    [{ code: 'DRAFT_NAME_CONFLICT', status: 409 }, 'conflict'],
  ]) assert.equal(resolveErrorPresentation({ error }, { operation: 'upload' }).key, `apiErrors.${key}`);
});

test('locale changes affect the next presentation without changing the response', () => {
  const result = { error: { code: 'PROMPT_TOO_LONG', details: { max: 500 } } };
  setLocale('en', { persist: false });
  const english = getApiErrorMessage(result, 'publish');
  setLocale('zh-Hant', { persist: false });
  const chinese = getApiErrorMessage(result, 'publish');
  assert.notEqual(english, chinese);
  assert.match(english, /500/);
  assert.match(chinese, /500/);
  assert.equal(resolveErrorPresentation(result).params.max, 500);
  setLocale('en', { persist: false });
});


test('malformed diagnostics and prototype-like keys cannot break error presentation', () => {
  for (const status of [null, {}, [], { toString: 1, valueOf: 2 }, 'secret', Infinity]) {
    const presentation = resolveErrorPresentation({ error: { code: 'constructor', status } }, { operation: '__proto__' });
    assert.equal(presentation.key, 'apiErrors.unknown');
    assert.equal(presentation.diagnostic.status, undefined);
  }
  for (const max of ['500', '<img>', {}, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
    const presentation = resolveErrorPresentation({ error: { code: 'PROMPT_TOO_LONG', details: { max } } });
    assert.equal(presentation.key, 'apiErrors.promptTooLong');
    assert.deepEqual(presentation.params, {});
  }
});


test('retained HTTP rejection wins over cancellation and transport symptoms in every operation', () => {
  for (const code of ['NETWORK_ERROR', 'UPLOAD_TIMEOUT', 'REQUEST_TIMEOUT', 'ABORTED']) {
    for (const [status, key] of [[401, 'authRequired'], [403, 'authRequired'], [413, 'uploadTooLarge'], [429, 'rateLimited']]) {
      for (const operation of ['upload', 'download', 'audio', 'list']) {
        const result = Object.freeze({ error: Object.freeze({ code, status }) });
        assert.equal(resolveErrorPresentation(result, { operation }).key, `apiErrors.${key}`);
      }
    }
  }
  assert.equal(resolveErrorPresentation({ error: { code: 'NETWORK_ERROR', status: 409 } }, { operation: 'upload' }).key, 'apiErrors.uploadFailed');
  assert.equal(resolveErrorPresentation({ error: { code: 'ABORTED' } }, { operation: 'upload' }).key, 'apiErrors.uploadCanceled');
  assert.equal(resolveErrorPresentation({ error: { code: 'NETWORK_ERROR', status: 503 } }, { operation: 'upload' }).key, 'apiErrors.uploadUncertain');
});

for (const code of ['INVALID_ROLEPLAYSCENE_PACKAGE_ZIP', 'INVALID_ROLEPLAYSCENE_MANIFEST',
  'INVALID_ROLEPLAYSCENE_MANIFEST_JSON', 'INVALID_ROLEPLAYSCENE_PROJECT_JSON',
  'INVALID_ROLEPLAYSCENE_PROJECT', 'INVALID_ROLEPLAYSCENE_PUBLISH_PACKAGE',
  'UNSUPPORTED_ROLEPLAYSCENE_PACKAGE_FORMAT', 'UNSUPPORTED_ROLEPLAYSCENE_PACKAGE_VERSION',
  'ROLEPLAYSCENE_PACKAGE_MISSING_MANIFEST', 'ROLEPLAYSCENE_PACKAGE_MISSING_PROJECT',
  'ROLEPLAYSCENE_PACKAGE_RESOURCE_LIMIT_EXCEEDED']) {
  test(`RolePlayScene service rejection ${code} has localized actionable guidance`, () => {
    const key = code.endsWith('RESOURCE_LIMIT_EXCEEDED') ? 'packageLimits' : 'invalidPackage';
    const result = { ok: false, error: { code, status: 400, message: 'PRIVATE_RAW_MESSAGE' } };
    for (const operation of ['upload', 'publish']) for (const locale of ['en', 'zh-Hant']) {
      setLocale(locale, { persist: false });
      try {
        assert.equal(resolveErrorPresentation(result, { operation }).key, `apiErrors.${key}`);
        assert.equal(getApiErrorMessage(result, operation), (locale === 'en' ? en : zh).apiErrors[key]);
        assert.equal(resolveErrorPresentation(result, { operation, source: 'bridge' }).key, `apiErrors.${operation}Failed`);
      } finally { setLocale('en', { persist: false }); }
    }
  });
}

test('uncertain deletion guidance is localized and does not promise safe automatic retry',()=>{
  for(const locale of ['en','zh-Hant']) {
    setLocale(locale,{persist:false});
    const message=getApiErrorMessage({ok:false,error:{code:'DELETE_OUTCOME_UNCERTAIN',message:'raw secret'}},'delete');
    assert.equal(message,(locale==='en'?en:zh).apiErrors.deleteUncertain);
    assert.ok(!message.includes('raw secret'));
  }
  setLocale('en',{persist:false});
});
