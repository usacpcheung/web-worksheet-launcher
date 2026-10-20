import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderResult, runProviderRequest } from './provider-request.js';
import { createReadAuthFlow } from '../auth/read-auth-flow.js';
import { createServerApiClient } from '../api/server-api-client.js';

const readyAuth = () => ({ ensure: async () => ({ ok: true }), captureContext: () => () => true });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const success = { ok: true, data: { text: 'fixture' }, status: 200 };

for (const [value, expected] of [
  [{ error: { code: 'FORBIDDEN', status: 403, requiresSignIn: true } }, 'permission_denied'],
  [{ error: { code: 'FORBIDDEN', status: 401 } }, 'authentication_required'],
  [{ error: { code: 'AUTH_REQUIRED', status: 503, requiresSignIn: true } }, 'failed'],
  [{ error: { code: 'AUTH_REQUIRED', status: 200 } }, 'authentication_required'],
  [{ error: { status: 429 } }, 'rate_limited'],
  [{ error: { status: 413 } }, 'too_large'],
  [{ error: { status: 409 } }, 'busy'],
  [{ error: { code: 'ABORTED' } }, 'cancelled'],
  [{ error: { code: 'REQUEST_TIMEOUT' } }, 'timeout'],
  [{ error: { code: 'NETWORK_ERROR' } }, 'network_error'],
  [{ error: { code: 'BRIDGE_EMPTY_RESPONSE' } }, 'invalid_response'],
  [null, 'failed'],
]) {
  test(`classifies ${JSON.stringify(value)} as ${expected}`, () => {
    assert.equal(normalizeProviderResult(value).kind, expected);
  });
}

test('failure boundary excludes arbitrary upstream messages and details', () => {
  const result = normalizeProviderResult({ error: { code: 'PRIVATE_CONTENT', message: 'secret', details: { bodyPreview: 'secret' } } });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(result.error.code, 'API_ERROR');
});

test('already canceled invocation does not probe or send', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runProviderRequest({ auth: { ensure: () => assert.fail() }, signal: controller.signal, request: () => assert.fail() });
  assert.equal(result.kind, 'cancelled');
});

test('real auth coordinator verifies login but does not send provider request', async () => {
  let signedIn = false, probes = 0, sends = 0;
  const auth = createReadAuthFlow({
    probe: async () => { probes++; return signedIn ? { ok: true, status: 'ready', user: { sub: 'a' } }
      : { ok: false, error: { code: 'AUTH_REQUIRED' } }; },
    signIn: async () => { signedIn = true; return { ok: true }; },
    prompt: async () => true, subject: () => signedIn ? 'a' : null, invalidate: () => {},
  });
  const options = { auth, request: async () => { sends++; return success; } };
  assert.equal((await runProviderRequest(options)).kind, 'retry_required');
  assert.equal(probes, 2); assert.equal(sends, 0);
  assert.equal((await runProviderRequest(options)).kind, 'success');
  assert.equal(sends, 1);
});

test('late API authentication failure never triggers another login or request', async () => {
  let probes = 0, sends = 0;
  const auth = readyAuth(); auth.ensure = async () => { probes++; return { ok: true }; };
  const result = await runProviderRequest({ auth, request: async () => {
    sends++; return { ok: false, error: { code: 'AUTH_REQUIRED', status: 401 } };
  } });
  assert.equal(result.kind, 'authentication_required'); assert.equal(sends, 1); assert.equal(probes, 1);
});

for (const phase of ['auth', 'request']) {
  test(`cancellation settles stalled ${phase} and consumes late rejection`, async () => {
    const entered = deferred(), pending = deferred(), controller = new AbortController();
    const task = () => { entered.resolve(); return pending.promise; };
    const auth = readyAuth(); if (phase === 'auth') auth.ensure = task;
    const result = runProviderRequest({ auth, signal: controller.signal, request: phase === 'request' ? task : () => assert.fail() });
    await entered.promise; controller.abort();
    assert.equal((await result).kind, 'cancelled');
    pending.reject(new Error('private late rejection'));
    await new Promise(resolve => setImmediate(resolve));
  });
}

test('explicit deadline settles ignored abort and forwards cancellation to transport', async () => {
  let requestSignal;
  const result = await runProviderRequest({ auth: readyAuth(), timeoutMs: 15,
    request: ({ signal }) => { requestSignal = signal; return new Promise(() => {}); } });
  assert.equal(result.kind, 'timeout'); assert.equal(requestSignal.aborted, true);
});

test('context replacement releases a stalled request; unrelated operation continues', async () => {
  let current = true; const entered = deferred(), pending = deferred();
  const first = runProviderRequest({ auth: readyAuth(), isCurrent: () => current,
    request: () => { entered.resolve(); return pending.promise; } });
  await entered.promise; current = false;
  assert.equal((await runProviderRequest({ auth: readyAuth(), request: async () => success })).kind, 'success');
  assert.equal((await first).kind, 'superseded');
  pending.resolve(success);
});

test('account lease invalidates both pending output and an already returned result', async () => {
  let account = 'a'; const auth = readyAuth();
  auth.captureContext = () => { const captured = account; return () => captured === account; };
  const good = await runProviderRequest({ auth, request: async () => success });
  assert.equal(good.isCurrent(), true); account = 'b'; assert.equal(good.isCurrent(), false);
  const stale = await runProviderRequest({ auth, request: async () => { account = 'c'; return success; } });
  assert.equal(stale.kind, 'superseded');
});

test('abort during successful response prevents application', async () => {
  const controller = new AbortController();
  const result = await runProviderRequest({ auth: readyAuth(), signal: controller.signal,
    request: async () => { controller.abort(); return success; } });
  assert.equal(result.kind, 'cancelled'); assert.equal(result.isCurrent(), false);
});

test('synchronous transport exception is sanitized and never retried', async () => {
  let sends = 0;
  const result = await runProviderRequest({ auth: readyAuth(), request: () => { sends++; throw new Error('secret'); } });
  assert.equal(result.kind, 'network_error'); assert.equal(sends, 1);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

for (const method of ['rewriteText', 'transcribeAudio', 'generateAudioFromText']) {
  test(`${method} existing client works through opt-in foundation`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      calls++; assert.ok(init.signal); assert.equal(init.credentials, 'include');
      return method === 'generateAudioFromText'
        ? new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } })
        : new Response(JSON.stringify({ ok: true, result: 'fixture' }), { headers: { 'content-type': 'application/json' } });
    });
    const api = createServerApiClient();
    const result = await runProviderRequest({ auth: readyAuth(), request: ({ signal }) =>
      method === 'generateAudioFromText' ? api[method]('fixture', {}, { signal })
        : api[method](method === 'transcribeAudio' ? new Blob(['fixture']) : 'fixture', { signal }) });
    assert.equal(result.kind, 'success'); assert.equal(calls, 1);
  });
}

for (const code of ['FORBIDDEN', 'NETWORK_ERROR', 'SESSION_PROBE_TIMEOUT']) {
  test(`preflight ${code} stops before provider request`, async () => {
    const auth = readyAuth(); auth.ensure = async () => ({ ok: false, error: { code } });
    const result = await runProviderRequest({ auth, request: () => assert.fail('must not send') });
    assert.equal(result.ok, false); assert.equal(result.isCurrent(), false);
  });
}

test('canceling one login subscriber does not cancel a second current subscriber', async () => {
  const login = deferred(), entered = deferred(); let signedIn = false, logins = 0;
  const auth = createReadAuthFlow({
    probe: async () => signedIn ? { ok: true, status: 'ready', user: { sub: 'a' } }
      : { ok: false, error: { code: 'AUTH_REQUIRED' } },
    signIn: async () => { logins++; entered.resolve(); await login.promise; signedIn = true; return { ok: true }; },
    prompt: async () => true, subject: () => signedIn ? 'a' : null, invalidate: () => {},
  });
  const controller = new AbortController();
  const first = runProviderRequest({ auth, signal: controller.signal, request: () => assert.fail() });
  const second = runProviderRequest({ auth, request: () => assert.fail() });
  await entered.promise; controller.abort();
  assert.equal((await first).kind, 'cancelled');
  login.resolve(); assert.equal((await second).kind, 'retry_required'); assert.equal(logins, 1);
});

test('real client response body stalls: cancellation settles without late success', async t => {
  const entered = deferred(), body = deferred(), controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200, ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => { entered.resolve(); return body.promise; } }));
  const pending = runProviderRequest({ auth: readyAuth(), signal: controller.signal,
    request: ({ signal }) => createServerApiClient().rewriteText('fixture', { signal }) });
  await entered.promise; controller.abort();
  assert.equal((await pending).kind, 'cancelled');
  body.resolve({ ok: true, result: 'late' });
  await new Promise(resolve => setImmediate(resolve));
});

test('invalid timeout configuration is rejected before preflight', async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, '100', 2147483648]) {
    await assert.rejects(runProviderRequest({ timeoutMs, auth: { ensure: () => assert.fail() }, request: () => assert.fail() }), TypeError);
  }
});

test('transport AbortError remains cancellation without exposing its message', async () => {
  const result = await runProviderRequest({ auth: readyAuth(), request: () => { throw new DOMException('private', 'AbortError'); } });
  assert.equal(result.kind, 'cancelled'); assert.equal(JSON.stringify(result).includes('private'), false);
});
