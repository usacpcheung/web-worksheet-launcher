import test from 'node:test';
import assert from 'node:assert/strict';
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
