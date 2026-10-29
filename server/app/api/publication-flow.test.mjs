import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublicationAttempt, runPublicationFlow } from './publication-flow.js';
const success = { ok: true, data: { id: 'published' } };
const conflict = { ok: false, error: { code: 'NAME_CONFLICT' } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const boundary of ['form', 'preflight', 'submit', 'refresh', 'conflict']) {
  test(`ownership loss during ${boundary} prevents subsequent work without losing a submitted outcome`, async () => {
    const wait = deferred(); let current = true; const calls = [];
    const step = async (name, value) => { calls.push(name); if (name === boundary) await wait.promise; return value; };
    const work = runPublicationFlow({ initialMetadata: {}, isCurrent: () => current,
      collectMetadata: () => step('form', {}),
      publish: () => runPublicationAttempt({ isCurrent: () => current,
        preflight: () => step('preflight', { ok: true }),
        submit: () => step('submit', boundary === 'conflict' ? conflict : success),
        onSubmitted: () => calls.push('notice'), refresh: () => step('refresh', { ok: true }) }),
      isConflict: r => r.error?.code === 'NAME_CONFLICT', chooseConflict: () => step('conflict', 'edit'),
    });
    await tick(); assert.ok(calls.includes(boundary)); current = false; wait.resolve();
    const result = await work;
    assert.equal(calls.filter(x => x === 'form').length, 1);
    if (['form', 'preflight'].includes(boundary)) { assert.equal(result.status, 'superseded'); assert.ok(!calls.includes('submit')); }
    if (boundary === 'submit') { assert.equal(result.publicationResult, success); assert.ok(!calls.includes('notice')); }
    if (boundary === 'refresh') { assert.equal(result.ok, true); assert.equal(result.refreshStatus, 'superseded'); }
    if (boundary === 'conflict') assert.equal(result.publicationResult, conflict);
  });
}

test('only explicit conflict edit and a newly confirmed form permit a second submission', async () => {
  for (const choice of [null, 'cancel', 'edit']) {
    let forms = 0, submits = 0, preparations = 0;
    const result = await runPublicationFlow({ initialMetadata: { title: 'original' },
      collectMetadata: previous => { forms++; assert.equal(previous.title, forms === 1 ? 'original' : 'taken'); return { title: forms === 1 ? 'taken' : 'renamed' }; },
      publish: metadata => runPublicationAttempt({
        preflight: async () => { preparations++; return { ok: true }; },
        submit: async () => { submits++; assert.equal(metadata.title, submits === 1 ? 'taken' : 'renamed'); return submits === 1 ? conflict : success; },
      }), isConflict: r => r.error?.code === 'NAME_CONFLICT', chooseConflict: async () => choice,
    });
    assert.equal(submits, choice === 'edit' ? 2 : 1); assert.equal(preparations, submits);
    assert.equal(forms, submits); assert.equal(result.publicationResult, choice === 'edit' ? success : conflict);
  }
});

test('canceling initial or retry form sends no additional request', async () => {
  for (const cancelAt of [1, 2]) {
    let forms = 0, submits = 0;
    const result = await runPublicationFlow({ initialMetadata: {}, collectMetadata: () => ++forms === cancelAt ? null : {},
      publish: async () => { submits++; return conflict; }, isConflict: () => true, chooseConflict: async () => 'edit' });
    assert.equal(result.status, 'cancelled'); assert.equal(submits, cancelAt - 1);
  }
});

for (const response of [
  { ok: false, error: { code: 'AUTH_REQUIRED', status: 401 } },
  { ok: false, error: { code: 'FORBIDDEN', status: 403 } },
  { ok: false, error: { code: 'NETWORK_ERROR' } },
  { ok: false, error: { code: 'INVALID_JSON_RESPONSE' } },
  { ok: false, error: { code: 'SERVER_ERROR', status: 503 } },
]) test(`submission ${response.error.code} is returned without replay`, async () => {
  let sends = 0;
  const result = await runPublicationFlow({ initialMetadata: {}, collectMetadata: async () => ({}),
    publish: () => runPublicationAttempt({ preflight: async () => ({ ok: true }), submit: async () => { sends++; return response; }, refresh: () => assert.fail('must not refresh') }),
    isConflict: r => r.error?.code === 'NAME_CONFLICT', chooseConflict: () => assert.fail('must not offer conflict') });
  assert.equal(sends, 1); assert.equal(result.publicationResult, response);
});

test('failed or canceled preparation sends nothing', async () => {
  for (const result of [{ ok: false, cancelled: true }, { ok: false, skipped: true }, { ok: false, error: { code: 'AUTH_REQUIRED' } }]) {
    const outcome = await runPublicationAttempt({ preflight: async () => ({ ok: false, result }), submit: () => assert.fail('not authorized') });
    assert.equal(outcome.phase, 'preflight'); assert.equal(outcome.ok, false);
  }
});

test('confirmed publication survives returned and thrown refresh failures', async () => {
  for (const throws of [false, true]) {
    const notices = [];
    const outcome = await runPublicationAttempt({ preflight: async () => ({ ok: true }), submit: async () => success,
      onSubmitted: r => notices.push(r), refresh: async () => { if (throws) throw Error('offline'); return { ok: false, error: { code: 'NETWORK_ERROR' } }; } });
    assert.equal(outcome.ok, true); assert.equal(outcome.publicationResult, success);
    assert.equal(outcome.refreshStatus, 'failed'); assert.deepEqual(notices, [success]);
  }
});

test('superseded refresh is not reported as failure', async () => {
  for (const status of ['superseded', 'stale_response']) {
    const outcome = await runPublicationAttempt({ preflight: async () => ({ ok: true }), submit: async () => success, refresh: async () => ({ ok: false, status }) });
    assert.equal(outcome.refreshStatus, 'superseded'); assert.equal(outcome.ok, true);
  }
});

test('exceptions preserve stage and never resend', async () => {
  for (const stage of ['preflight', 'submission']) {
    let sends = 0;
    const result = await runPublicationAttempt({ preflight: async () => { if (stage === 'preflight') throw Error('offline'); return { ok: true }; },
      submit: async () => { sends++; throw Error('lost response'); } });
    assert.equal(result.phase, stage); assert.equal(result.ok, false); assert.equal(sends, stage === 'preflight' ? 0 : 1);
  }
});
