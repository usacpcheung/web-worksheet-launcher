import { runOwnedSessionProbe } from '../../app/auth/session-coordinator.js';
import { getApiErrorMessage } from '../../app/api/error-presentation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { probeSession } from '../../app/auth/session-readiness.js';
import { createServerApiClient } from '../../app/api/server-api-client.js';

// Execute the actual app wiring without bootstrapping its DOM and storage.
const source = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const wiring = source.slice(source.indexOf('async function probeServerSessionSilently('), source.indexOf('function startServerSignIn()'));
function harness(apiClient, timeoutMs = 10) {
  const notices = [];
  const boundedProbe = options => {
    assert.equal(options.timeoutMs, 15000);
    return probeSession({ ...options, timeoutMs });
  };
  const app = new Function('apiClient', 'probeSession', 'showMessage', 'getApiErrorMessage', 'runOwnedSessionProbe', `
    let serverSession;
    const updateServerSessionUi = () => {};
    const translate = id => id;
    ${wiring}
    return { ensureServerSessionReady, probeServerSessionSilently,
      state: () => serverSession, setState: state => { serverSession = state; } };
  `)(apiClient, boundedProbe, notice => notices.push(notice), getApiErrorMessage, runOwnedSessionProbe);
  return { ...app, notices };
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


test('obsolete preflight results cannot publish session state or notifications', async () => {
  for (const newer of [false, true]) for (const outcome of ['success', '503', 'network', 'timeout']) {
    let finish, current = true, calls = 0;
    const app = harness({ getSession: () => ++calls === 1
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ ok: true, data: { user: { sub: 'new' } } }) });
    const initial = { status: 'ready', user: { sub: 'original' }, error: null };
    app.setState(initial);
    const pending = app.ensureServerSessionReady({ isCurrent: () => current });
    current = false;
    if (newer) await app.ensureServerSessionReady();
    const expected = newer ? app.state() : initial;
    if (outcome !== 'timeout') finish(outcome === 'success'
      ? { ok: true, data: { user: { sub: 'obsolete' } } }
      : { ok: false, error: { code: outcome === '503' ? 'SERVICE_BUSY' : 'NETWORK_ERROR', status: outcome === '503' ? 503 : null } });
    assert.equal((await pending).result.status, 'superseded');
    assert.equal(app.state(), expected);
    assert.deepEqual(app.notices, []);
    assert.equal((await app.ensureServerSessionReady()).ok, true);
    if (outcome === 'timeout') finish({ ok: false, error: { code: 'NETWORK_ERROR' } });
  }
});

test('a superseded probe cannot report failure even if its caller remains current', async () => {
  let finish, calls = 0;
  const app = harness({ getSession: () => ++calls === 1
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ ok: true, data: { user: { sub: 'new' } } }) });
  const old = app.ensureServerSessionReady();
  await app.ensureServerSessionReady();
  finish({ ok: false, error: { code: 'NETWORK_ERROR' } });
  assert.equal((await old).result.status, 'superseded');
  assert.deepEqual(app.notices, []);
  assert.equal(app.state().status, 'ready');
});


test('concurrent current actions accept same-account success in either completion order', async () => {
  for (const olderFirst of [true, false]) {
    const resolvers = [];
    const app = harness({ getSession: () => new Promise(resolve => resolvers.push(resolve)) }, 1000);
    app.setState({status:'ready',user:{sub:'same'}});
    const old = app.ensureServerSessionReady();
    const next = app.ensureServerSessionReady();
    const success = {ok:true,data:{user:{sub:'same'}}};
    resolvers[olderFirst ? 0 : 1](success);
    await Promise.resolve();
    resolvers[olderFirst ? 1 : 0](success);
    assert.equal((await old).ok,true);
    assert.equal((await next).ok,true);
    assert.equal(app.state().user.sub,'same');
    assert.deepEqual(app.notices,[]);
  }
});

test('older success cannot bypass newer failure, account change or caller cancellation', async () => {
  for (const kind of ['failure','account','cancel']) for (const olderFirst of [true,false]) {
    const resolvers=[];let current=true;
    const app=harness({getSession:()=>new Promise(resolve=>resolvers.push(resolve))},1000);
    app.setState({status:'ready',user:{sub:'same'}});
    const old=app.ensureServerSessionReady({isCurrent:()=>current});
    const next=app.ensureServerSessionReady();
    const results=[{ok:true,data:{user:{sub:'same'}}},kind==='failure'
      ? {ok:false,error:{code:'AUTH_REQUIRED'}} : {ok:true,data:{user:{sub:kind==='account'?'other':'same'}}}];
    if(kind==='cancel')current=false;
    resolvers[olderFirst?0:1](results[olderFirst?0:1]);await Promise.resolve();
    resolvers[olderFirst?1:0](results[olderFirst?1:0]);
    await next;const state=app.state();const notices=app.notices.length;
    assert.equal((await old).result.status,'superseded');
    assert.equal(app.state(),state);assert.equal(app.notices.length,notices);
  }
});
