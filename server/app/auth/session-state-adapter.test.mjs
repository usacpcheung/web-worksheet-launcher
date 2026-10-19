import test from 'node:test';
import assert from 'node:assert/strict';
import { runOwnedSessionProbe } from './session-coordinator.js';
import { createSilentSessionStateAdapter } from './session-state-adapter.js';
test('silent overlapping probes preserve visible state and both same-account callers', async () => {
  let state = { status: 'ready', user: { sub: 'a' } }; const initial = state; const writes = []; const replies = [];
  const adapter = createSilentSessionStateAdapter({ readState: () => state, writeState: next => { state = next; writes.push(next); } });
  const run = () => runOwnedSessionProbe({ ...adapter, probe: () => new Promise(resolve => replies.push(resolve)), presentError: () => 'failure' });
  const old = run(), newer = run(); assert.equal(state, initial); assert.equal(writes.length, 0);
  replies[0]({ ok: true, status: 'ready', user: { sub: 'a' } });
  replies[1]({ ok: true, status: 'ready', user: { sub: 'a' } });
  assert.equal((await old).ok, true); assert.equal((await newer).ok, true); assert.equal(writes.length, 1);
});
test('external logout supersedes an old silent success', async () => {
  let state = { status: 'ready', user: { sub: 'a' } }, finish;
  const adapter = createSilentSessionStateAdapter({ readState: () => state, writeState: next => { state = next; } });
  const pending = runOwnedSessionProbe({ ...adapter, probe: () => new Promise(resolve => { finish = resolve; }), presentError: () => 'failure' });
  state = { status: 'not_ready', user: null }; const loggedOut = state;
  finish({ ok: true, status: 'ready', user: { sub: 'a' } });
  assert.equal((await pending).skipped, true); assert.equal(state, loggedOut);
});
