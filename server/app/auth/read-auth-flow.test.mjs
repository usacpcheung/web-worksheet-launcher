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
