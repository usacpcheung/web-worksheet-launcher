import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProviderResult } from '../bridge/provider-request.js';
import { createServerApiClient } from './server-api-client.js';

// Shared transports preserve explicit permission denial separately from login.
const methods = ['rewriteText', 'transcribeAudio', 'generateAudioFromText'];
const invoke = (method, signal) => {
  const api = createServerApiClient();
  return method === 'generateAudioFromText' ? api[method]('fixture', {}, { signal })
    : api[method](method === 'transcribeAudio' ? new Blob(['fixture']) : 'fixture', { signal });
};
for (const method of methods) {
  for (const [status, body, expected] of [
    [401, { ok: false }, 'AUTH_REQUIRED'],
    [403, { ok: false, error: { code: 'FORBIDDEN' } }, 'FORBIDDEN'],
    [429, { ok: false, error: { code: 'RATE_LIMITED' } }, 'RATE_LIMITED'],
    [503, { ok: false, error: { code: 'UNAVAILABLE' } }, 'UNAVAILABLE'],
  ]) {
    test(`${method}: existing ${status} error contract sends once`, async t => {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      });
      const result = await invoke(method);
      assert.equal(result.error.code, expected);
      assert.equal(result.error.status, status);
      assert.equal(result.error.requiresSignIn, status === 401 || (status === 403 && method !== 'generateAudioFromText'));
      assert.equal(calls, 1);
    });
  }
  test(`${method}: OIDC HTML response retains authentication signal`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }));
    assert.equal((await invoke(method)).error.requiresSignIn, true);
  });
  test(`${method}: offline makes one request without retry`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('fixture offline'); });
    assert.equal((await invoke(method)).error.code, 'NETWORK_ERROR');
    assert.equal(calls, 1);
  });
}


for (const method of methods) for (const status of [401, 403, 429, 503]) {
  for (const contentType of ['application/json', 'text/html']) {
    test(`${method} retains ${status} after interrupted ${contentType} body`, async t => {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response(new ReadableStream({ start(controller) {
          controller.error(new TypeError('PRIVATE interrupted body'));
        } }), { status, headers: { 'content-type': contentType } });
      });
      const result = await invoke(method, new AbortController().signal);
      assert.equal(result.error.status, status);
      assert.equal(result.error.requiresSignIn, status === 401 || status === 403);
      const normalized = normalizeProviderResult(result);
      assert.equal(normalized.kind, status < 404 ? 'authentication_required' : status === 429 ? 'rate_limited' : 'failed');
      assert.equal(JSON.stringify(normalized).includes('PRIVATE'), false);
      assert.equal(calls, 1);
    });
  }
}

for (const method of methods) {
  test(`${method} distinguishes explicit cancel from interrupted rejection`, async t => {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      const interrupted = async () => {
        if (cancel) controller.abort();
        throw new DOMException('Body aborted', 'AbortError');
      };
      t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403,
        headers: new Headers({ 'content-type': 'application/json' }), text: interrupted, json: interrupted }));
      const result = await invoke(method, controller.signal);
      assert.equal(result.error.code, cancel ? 'ABORTED' : 'AUTH_REQUIRED');
      assert.equal(result.error.requiresSignIn, !cancel);
      t.mock.restoreAll();
    }
  });
}

test('T2A HTTP 401 settles without waiting for a stalled error body', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401,
    headers: new Headers({ 'content-type': 'text/html' }), text: () => assert.fail('401 does not require a body') }));
  assert.equal((await invoke('generateAudioFromText')).error.code, 'AUTH_REQUIRED');
});
