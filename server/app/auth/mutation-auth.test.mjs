import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadAuthFlow } from './read-auth-flow.js';
import { prepareMutation } from './mutation-auth.js';
const signedOut = { ok: false, error: { code: 'AUTH_REQUIRED', status: 401 } };
const ready = sub => ({ ok: true, status: 'ready', user: { sub } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ loggedIn = false, account = 'A' } = {}) {
  const state = { loggedIn, account, prompts: 0, logins: 0, confirmations: 0 };
  const auth = createReadAuthFlow({
    subject: () => state.loggedIn ? state.account : null,
    probe: async () => state.loggedIn ? ready(state.account) : { ...signedOut },
    prompt: async () => { state.prompts++; return true; },
    signIn: async () => { state.logins++; state.loggedIn = true; return { ok: true }; },
    invalidate() {},
  });
  const prepare = (options = {}) => prepareMutation(auth, { intent: { kind: 'mutation', operation: 'upload' },
    confirm: async () => { state.confirmations++; return true; }, ...options });
  return { state, auth, prepare };
}
test('signed-in click prepares without a redundant confirmation', async () => {
  const h = harness({ loggedIn: true }); const result = await h.prepare();
  assert.equal(result.ok, true); assert.equal(result.isCurrent(), true);
  assert.equal(h.state.logins, 0); assert.equal(h.state.confirmations, 0);
});
test('login success does not release preparation until explicit confirmation', async () => {
  const h = harness(); const confirmation = deferred(); let completed = false;
  const work = h.prepare({ confirm: () => confirmation.promise }).then(r => { completed = true; return r; });
  await tick(); assert.equal(h.state.logins, 1); assert.equal(completed, false);
  confirmation.resolve(true); assert.equal((await work).ok, true);
});
test('cancel after login returns no mutation authorization', async () => {
  const h = harness(); const result = await h.prepare({ confirm: async () => false });
  assert.equal(result.ok, false); assert.equal(result.result.cancelled, true);
});
test('account switch during confirmation invalidates the prepared action', async () => {
  const h = harness(); const confirmation = deferred();
  const work = h.prepare({ confirm: () => confirmation.promise }); await tick();
  h.state.account = 'B'; h.auth.observe(ready('B')); confirmation.resolve(true);
  assert.equal((await work).result.status, 'superseded');
});
test('account context remains guarded through later archive construction', async () => {
  const h = harness({ loggedIn: true }); const result = await h.prepare();
  h.state.account = 'B'; assert.equal(result.isCurrent(), false);
});
test('auth failure invalidates prepared work even before another successful probe', async () => {
  const h = harness({ loggedIn: true }); const result = await h.prepare();
  h.auth.observe({ ...signedOut }); assert.equal(result.isCurrent(), false);
});
test('reads and mutations coalesce login but only the mutation needs confirmation', async () => {
  const h = harness(); const confirmation = deferred(); let reads = 0;
  const mutation = h.prepare({ confirm: () => confirmation.promise });
  const read = h.auth.read(async () => { reads++; return { ok: true }; });
  assert.equal((await read).ok, true); assert.equal(reads, 1); assert.equal(h.state.logins, 1);
  confirmation.resolve(false); assert.equal((await mutation).ok, false);
});
test('canceling one subscriber leaves another login usable', async () => {
  const h = harness(); let current = true;
  const first = h.prepare({ isCurrent: () => current }); const second = h.prepare(); current = false;
  assert.equal((await first).ok, false); assert.equal((await second).ok, true); assert.equal(h.state.logins, 1);
});
for (const code of ['FORBIDDEN', 'NETWORK_ERROR']) test(`${code} never opens login or confirmation`, async () => {
  let prompts = 0;
  const auth = createReadAuthFlow({ subject: () => null, probe: async () => ({ ok: false, error: { code, status: code === 'FORBIDDEN' ? 403 : 0 } }),
    prompt: async () => { prompts++; return true; }, signIn: async () => assert.fail('unexpected sign in'), invalidate() {} });
  const result = await prepareMutation(auth, { confirm: async () => assert.fail('unexpected confirmation') });
  assert.equal(result.ok, false); assert.equal(prompts, 0);
});
test('aborting confirmation cannot authorize a mutation', async () => {
  const h = harness(); const controller = new AbortController();
  const result = await h.prepare({ signal: controller.signal, confirm: async () => { controller.abort(); return true; } });
  assert.equal(result.ok, false);
});

test('initial confirmation identity survives same-account expiry but rejects an intervening account switch', async () => {
  const h = harness({loggedIn:true});
  const identity = h.auth.captureIdentity();
  h.state.loggedIn = false; h.auth.observe({...signedOut}); assert.equal(identity(),true);
  h.state.loggedIn = true; h.auth.observe(ready('A')); assert.equal(identity(),true);
  h.state.account = 'B'; h.auth.observe(ready('B')); assert.equal(identity(),false);
  assert.equal((await h.prepare({isCurrent:identity})).ok,false);
});

for (const recovered of [false, true]) {
  test(`new sign-out after ensure cannot authorize mutation (recovered=${recovered})`, async () => {
    const h = harness({ loggedIn: !recovered });
    const ensure = h.auth.ensure;
    h.auth.ensure = async options => {
      const result = await ensure(options);
      h.auth.observe({ ...signedOut });
      return result;
    };
    const result = await h.prepare();
    assert.equal(result.ok, false); assert.equal(result.isCurrent(), false);
    assert.equal(h.state.confirmations, 0);
  });
}

test('expiry while explicit mutation confirmation is open invalidates consent', async () => {
  const h = harness(); const entered = deferred(), consent = deferred();
  const pending = h.prepare({ confirm: () => { entered.resolve(); return consent.promise; } });
  await entered.promise; h.auth.observe({ ...signedOut }); consent.resolve(true);
  assert.equal((await pending).ok, false);
});
