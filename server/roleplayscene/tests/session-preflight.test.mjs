import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { probeSession } from '../../app/auth/session-readiness.js';
import { createServerApiClient } from '../../app/api/server-api-client.js';

// Execute the actual app wiring without bootstrapping its DOM and storage.
const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const wiring = source.slice(source.indexOf('async function probeServerSessionSilently('), source.indexOf('function startServerSignIn()'));
function harness(apiClient) {
  const notices = [];
  const boundedProbe = options => {
    assert.equal(options.timeoutMs, 15000);
    return probeSession({ ...options, timeoutMs: 10 });
  };
  return new Function('apiClient', 'probeSession', 'showMessage', `
    let serverSession;
    const updateServerSessionUi = () => {};
    const translate = id => id;
    ${wiring}
    return { ensureServerSessionReady, probeServerSessionSilently,
      state: () => serverSession, setState: state => { serverSession = state; } };
  `)(apiClient, boundedProbe, notice => notices.push(notice));
}

test('real preflight aborts a stalled fetch and manual retry starts a fresh request', async t => {
  let calls = 0, signal, finish;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    if (calls === 1) {
      signal = options.signal;
      return new Promise(resolve => { finish = resolve; });
    }
    return Response.json({ ok: true, data: { user: { sub: 'new-session' } } });
  });
  const app = harness(createServerApiClient());
  const first = await app.ensureServerSessionReady();
  assert.equal(first.ok, false);
  assert.equal(first.result.error.code, 'SESSION_PROBE_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal((await app.ensureServerSessionReady()).ok, true);
  assert.equal(calls, 2);
  finish(new Response('', { status: 401 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.state().status, 'ready');
});

test('older probes cannot replace a newer probe or explicit authentication state', async () => {
  for (const newer of ['probe', 'sign-in', 'expiry']) {
    let finish, calls = 0;
    const app = harness({ getSession: () => ++calls === 1
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ ok: true, data: { user: { sub: 'new' } } }) });
    const old = app.probeServerSessionSilently();
    if (newer === 'probe') await app.ensureServerSessionReady();
    else app.setState({ status: newer === 'sign-in' ? 'ready' : 'not_ready' });
    const expected = app.state();
    finish(newer === 'expiry' ? { ok: true, data: { user: { sub: 'old' } } }
      : { ok: false, error: { code: 'AUTH_REQUIRED' } });
    await old;
    assert.equal(app.state(), expected);
  }
});

test('HTML gateway errors remain service failures for session and audio; login responses require sign-in', async t => {
  const client = createServerApiClient();
  for (const status of [200, 401, 403, 502, 503]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>Response</html>', {
      status, headers: { 'content-type': 'text/html' },
    }));
    for (const result of [await client.getSession(), await client.generateAudioFromText('Hello', { voice_choice: 'cantonese_male_1' })]) {
      assert.equal(result.ok, false);
      assert.equal(result.error.status, status);
      assert.equal(result.error.requiresSignIn, status < 500);
    }
    t.mock.restoreAll();
  }
});
