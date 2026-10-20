import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadAuthFlow } from './read-auth-flow.js';
const ready = sub => ({ ok: true, status: 'ready', user: { sub } });
const auth = { ok: false, error: { status: 401, code: 'AUTH_REQUIRED' } };
function fixture(overrides = {}) {
  let user = 'a';
  const events = [];
  const flow = createReadAuthFlow({ probe: async () => ready(user), subject: () => user,
    prompt: async () => { events.push('prompt'); return true; },
    signIn: async () => { events.push('login'); return ready(user); },
    invalidate: reason => events.push(reason), ...overrides });
  return { flow, events, setUser: value => { user = value; } };
}
test('expired read repeats once after verified login', async () => {
  const { flow, events } = fixture(); let count = 0;
  assert.equal((await flow.read(async () => ++count === 1 ? auth : { ok: true })).ok, true);
  assert.equal(count, 2); assert.deepEqual(events, ['signed_out', 'prompt', 'login']);
});
test('repeated auth failure is bounded', async () => {
  const { flow, events } = fixture(); let count = 0;
  assert.equal(await flow.read(async () => { count++; return auth; }), auth);
  assert.equal(count, 2); assert.equal(events.filter(x => x === 'login').length, 1);
});
test('permission and service errors do not sign in or repeat', async () => {
  for (const error of [{ status: 403, code: 'FORBIDDEN', requiresSignIn: true }, { status: 503 }, { code: 'NETWORK_ERROR' }]) {
    const { flow, events } = fixture(); let count = 0;
    await flow.read(async () => { count++; return { ok: false, error }; });
    assert.equal(count, 1); assert.deepEqual(events, []);
  }
});
test('account change prevents read continuation', async () => {
  const { flow, events } = fixture({ probe: async () => ready('b') }); let count = 0;
  assert.equal((await flow.read(async () => { count++; return { ok: true }; })).skipped, true);
  assert.equal(count, 0); assert.deepEqual(events, ['account_changed']);
});
test('concurrent readers share prompt and login; canceling one preserves the other', async () => {
  let resolve; const gate = new Promise(r => { resolve = r; }); let current = true; let prompts = 0; let logins = 0;
  const { flow } = fixture({ prompt: async () => { prompts++; await gate; return true; }, signIn: async () => { logins++; return ready('a'); } });
  let a = 0, b = 0;
  const first = flow.read(async () => ++a === 1 ? auth : { ok: true }, { isCurrent: () => current });
  const second = flow.read(async () => ++b === 1 ? auth : { ok: true });
  await new Promise(r => setImmediate(r)); current = false; resolve();
  assert.equal((await first).skipped, true); assert.equal((await second).ok, true);
  assert.equal(a, 1); assert.equal(b, 2); assert.equal(prompts, 1); assert.equal(logins, 1);
});
test('canceled preflight and late read cannot publish success', async () => {
  let current = true;
  const { flow } = fixture();
  const result = await flow.read(async () => { current = false; return { ok: true }; }, { isCurrent: () => current });
  assert.equal(result.skipped, true);
});
test('a newer explicit auth failure suppresses an older successful read', async () => {
  let finish, cancelPrompt;
  const { flow } = fixture({ prompt: () => new Promise(resolve => { cancelPrompt = resolve; }) });
  const old = flow.read(() => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const newer = flow.read(async () => auth);
  await new Promise(resolve => setImmediate(resolve));
  finish({ ok: true, data: 'old account data' });
  assert.equal((await old).skipped, true);
  cancelPrompt(false); assert.equal((await newer).ok, false);
});
test('popup blocked can retry explicitly; no read before verified identity', async () => {
  let attempts = 0, prompts = 0, reads = 0;
  const { flow } = fixture({ probe: async () => attempts ? ready('a') : auth,
    prompt: async () => { prompts++; return true; },
    signIn: async () => ++attempts === 1 ? { ok: false, error: { code: 'AUTH_POPUP_BLOCKED' } } : ready('a') });
  assert.equal((await flow.read(async () => { reads++; return { ok: true }; })).ok, true);
  assert.equal(prompts, 2); assert.equal(reads, 1);
});
test('identity-less post-login verification cannot continue a read', async () => {
  let probes = 0, reads = 0;
  const { flow } = fixture({ probe: async () => ++probes === 1 ? auth : { ok: true, status: 'ready', user: null } });
  assert.equal((await flow.read(async () => { reads++; return { ok: true }; })).ok, false);
  assert.equal(reads, 0);
});
test('closing the only caller releases it while login is still pending', async () => {
  let current = true, finishLogin;
  const { flow } = fixture({ probe: async () => auth,
    signIn: () => new Promise(resolve => { finishLogin = resolve; }) });
  const pending = flow.read(async () => assert.fail('must not read'), { isCurrent: () => current });
  await new Promise(resolve => setImmediate(resolve)); current = false;
  assert.equal((await pending).skipped, true);
  finishLogin(ready('a'));
});
test('second auth failure invalidates a concurrent read begun after recovery', async () => {
  let finishRetry, finishOther, count = 0;
  const { flow } = fixture();
  const first = flow.read(() => ++count === 1 ? Promise.resolve(auth) : new Promise(resolve => { finishRetry = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const other = flow.read(() => new Promise(resolve => { finishOther = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  finishRetry(auth); await first;
  finishOther({ ok: true, data: 'outdated' }); assert.equal((await other).skipped,true);
});
test('an observed external logout suppresses already-running read results', async () => {
  let finish;
  const { flow, events } = fixture();
  const pending = flow.read(() => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  flow.observe(auth); flow.observe(auth);
  finish({ ok: true }); assert.equal((await pending).skipped, true);
  assert.deepEqual(events, ['signed_out']);
});

test('real probe ownership shares signed-out preflight and recovery for concurrent readers', async () => {
  const { runOwnedSessionProbe } = await import('./session-coordinator.js');
  for (const cancelFirst of [false, true]) {
    let state = { status: 'not_ready', user: null }, finish, signedIn = false, firstCurrent = true;
    let probes = 0, prompts = 0, logins = 0; const reads = [0, 0];
    const flow = createReadAuthFlow({ subject: () => state.user?.sub,
      probe: options => runOwnedSessionProbe({ ...options, readState: () => state, writeState: value => { state = value; }, presentError: () => 'sign in',
        probe: () => { probes++; return signedIn ? Promise.resolve(ready('a')) : new Promise(resolve => { finish = resolve; }); } }),
      invalidate() {}, prompt: async () => { prompts++; return true; }, signIn: async () => { logins++; signedIn = true; return ready('a'); } });
    const first = flow.read(async () => { reads[0]++; return { ok: true }; }, { isCurrent: () => firstCurrent });
    const second = flow.read(async () => { reads[1]++; return { ok: true }; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probes, 1);
    if (cancelFirst) firstCurrent = false;
    finish(auth);
    const results = await Promise.all([first, second]);
    assert.equal(results[1].ok, true); assert.equal(results[0].skipped === true, cancelFirst);
    assert.deepEqual(reads, [cancelFirst ? 0 : 1, 1]); assert.equal(prompts, 1); assert.equal(logins, 1);
  }
});

test('captured post-download context stops import after account change or logout', () => {
  for (const change of ['account', 'logout']) {
    const { flow, setUser } = fixture();
    const current = flow.captureContext(); assert.equal(current(), true);
    if (change === 'account') { setUser('b'); flow.observe(ready('b')); }
    else flow.observe(auth);
    assert.equal(current(), false);
  }
});

test('captured context permits a transient checking state but rejects its signed-out verdict', () => {
  const { flow, setUser } = fixture();
  const current = flow.captureContext();
  setUser(null);
  assert.equal(current(), true);
  flow.observe(auth);
  assert.equal(current(), false);
});

// Walk microtask boundaries around probe completion, ensure/recover settlement,
// and request invocation. No timers or arbitrary sleeps control these races.
for (const phase of ['preflight', 'recovery']) {
  test(`newer sign-out cannot authorize a read across ${phase} continuations`, async () => {
    for (let delay = 0; delay < 24; delay++) {
      let flow, invalidated = false, probes = 0, requests = 0, violation = false;
      const later = (n, callback) => queueMicrotask(() => n ? later(n - 1, callback) : callback());
      flow = createReadAuthFlow({ subject: () => 'a', invalidate() {},
        prompt: async () => true, signIn: async () => ready('a'),
        probe: async () => {
          probes++;
          if (phase === 'preflight' || probes > 1) {
            later(delay, () => { invalidated = true; flow.observe({ ...auth }); });
          }
          return ready('a');
        },
      });
      await flow.read(async () => {
        requests++;
        if (phase === 'recovery' && requests === 1) return { ...auth };
        violation ||= invalidated;
        return { ok: true };
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(violation, false, `${phase}, microtask offset ${delay}`);
      assert.ok(requests <= (phase === 'recovery' ? 2 : 1));
    }
  });
}

test('newer failure during login verification prevents read retry', async () => {
  let resolveProbe, probes = 0, requests = 0;
  const { flow } = fixture({ probe: async () => ++probes === 1 ? ready('a')
    : new Promise(resolve => { resolveProbe = resolve; }) });
  const work = flow.read(async () => { requests++; return { ...auth }; });
  await new Promise(resolve => setImmediate(resolve));
  flow.observe({ ...auth }); resolveProbe(ready('a'));
  assert.equal((await work).skipped, true); assert.equal(requests, 1);
});

test('late auth failure after completed recovery cannot start another login', async () => {
  let finishOld, count = 0;
  const { flow, events } = fixture();
  const old = flow.read(() => new Promise(resolve => { finishOld = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await flow.read(async () => ++count === 1 ? { ...auth } : { ok: true })).ok, true);
  finishOld({ ...auth });
  assert.equal((await old).skipped, true);
  assert.equal(events.filter(value => value === 'login').length, 1);
});

test('preflight-free read discards late auth failure after peer recovery finishes', async () => {
  let finishOld, count = 0;
  const { flow, events } = fixture();
  const old = flow.read(() => new Promise(resolve => { finishOld = resolve; }), { preflight: false });
  assert.equal((await flow.read(async () => ++count === 1 ? { ...auth } : { ok: true })).ok, true);
  finishOld({ ...auth });
  assert.equal((await old).skipped, true);
  assert.equal(events.filter(value => value === 'login').length, 1);
});

test('prepared verification cannot be recaptured after invalidation', async () => {
  const { flow } = fixture();
  const prepared = await flow.ensure({ withContext: true });
  flow.observe({ ...auth });
  assert.equal((await flow.read(() => assert.fail('stale prepared request'), { preflight: false, prepared })).skipped, true);
});

test('successful read carries its original guard through post-download work', async () => {
  const { flow } = fixture();
  const result = await flow.read(async () => ({ ok: true, data: 'fixture' }));
  assert.equal(result.isCurrent(), true);
  flow.observe({ ...auth });
  assert.equal(result.isCurrent(), false);
});

test('prepared read can replace its lease only through its own verified login recovery', async () => {
  const { flow } = fixture(); let sends = 0;
  const prepared = await flow.ensure({ withContext: true });
  const result = await flow.read(async () => ++sends === 1 ? { ...auth } : { ok: true }, { preflight: false, prepared });
  assert.equal(result.ok, true); assert.equal(result.isCurrent(), true); assert.equal(prepared.isCurrent(), false);
});

test('read with recovery disabled returns a guarded result without prompting or replay', async () => {
  const { flow, events } = fixture();
  assert.equal(await flow.read(async () => auth, { preflight: false, recoverAuth: false }), auth);
  assert.deepEqual(events, []);
  const result = await flow.read(async () => ({ ok: true }), { preflight: false, recoverAuth: false });
  flow.observe({ ...auth }); assert.equal(result.isCurrent(), false);
});
