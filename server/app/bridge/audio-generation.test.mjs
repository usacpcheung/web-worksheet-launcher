import test from 'node:test';
import assert from 'node:assert/strict';
import { runAudioGeneration } from './audio-generation.js';
import { createReadAuthFlow } from '../auth/read-auth-flow.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const ready = () => ({ ensure: async () => ({ ok: true, isCurrent: () => true }) });
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };

test('real auth preparation and late provider expiry never replay or prompt', async () => {
  for (const phase of ['prepare', 'provider']) {
    let calls = 0;
    const auth = createReadAuthFlow({ subject: () => 'A', invalidate: () => {},
      probe: async () => phase === 'prepare' ? { ok: false, error: { code: 'AUTH_REQUIRED' } }
        : { ok: true, status: 'ready', user: { sub: 'A' } },
      prompt: () => assert.fail('No automatic login'), signIn: () => assert.fail('No replay'),
    });
    const result = await runAudioGeneration({ auth, text: 'Source', voice: { voice_choice: 'english_narrator_female' },
      isCurrent: () => true, api: { generateAudioFromText: async () => { calls++; return { ok: false, error: { code: 'AUTH_REQUIRED', status: 401 } }; } } });
    assert.equal(result.kind, 'authentication_required');
    assert.equal(calls, phase === 'prepare' ? 0 : 1);
  }
});

for (const phase of ['prepare', 'provider']) for (const stop of ['cancel', 'stale', 'timeout']) {
  test(`${stop} during ${phase} settles stalled T2A and sends at most once`, async () => {
    let current = true, calls = 0; const controller = new AbortController(), gate = deferred();
    const promise = runAudioGeneration({ auth: phase === 'prepare' ? { ensure: () => gate.promise } : ready(),
      text: 'Text', isCurrent: () => current, signal: controller.signal, phaseTimeoutMs: stop === 'timeout' ? 10 : null,
      api: { generateAudioFromText: () => { calls++; return gate.promise; } } });
    await tick();
    if (stop === 'cancel') controller.abort();
    if (stop === 'stale') current = false;
    const result = await promise;
    assert.equal(result.kind, { cancel: 'cancelled', stale: 'superseded', timeout: 'timeout' }[stop]);
    assert.equal(calls, phase === 'prepare' ? 0 : 1);
    gate.resolve({ ok: true, data: new Uint8Array([1]), isCurrent: () => true });
  });
}

test('verified account guard survives response and rejects late attachment', async () => {
  let account = 'A'; const auth = createReadAuthFlow({ subject: () => account, invalidate: () => {},
    probe: async () => ({ ok: true, status: 'ready', user: { sub: account } }), prompt: () => false, signIn: () => {} });
  const result = await runAudioGeneration({ auth, text: 'Text', isCurrent: () => true,
    api: { generateAudioFromText: async (_text, _voice, { signal }) => {
      assert.equal(signal.aborted, false); return { ok: true, data: new Uint8Array([1]) };
    } } });
  assert.equal(result.isCurrent(), true);
  account = 'B'; auth.observe({ ok: true, status: 'ready', user: { sub: 'B' } });
  assert.equal(result.isCurrent(), false);
});

test('permission and transport errors expose safe categories and no raw provider body', async () => {
  for (const code of ['FORBIDDEN', 'NETWORK_ERROR', 'VOICE_CHOICE_UNSUPPORTED', 'API_ERROR']) {
    const result = await runAudioGeneration({ auth: ready(), text: 'private text', isCurrent: () => true,
      api: { generateAudioFromText: async () => ({ ok: false, error: { code, message: 'PRIVATE HTML' } }) } });
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(result.error.requiresSignIn, false);
  }
});
