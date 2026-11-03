import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBrowserEntry } from './browser-entry.js';
const fixture = () => ({ state: { localAttemptId: 'a' }, _uploadContextGeneration: 1,
  ensureReadSessionReady: async () => ({ ok: true, isCurrent: () => true }) });
test('only a verified, current browser request opens a browser', async () => {
  for (const ready of [{ ok: true, isCurrent: () => true }, { ok: true, isCurrent: () => false }, { ok: false, result: { cancelled: true } }]) {
    const session = fixture(); session.ensureReadSessionReady = async () => ready;
    assert.equal(await prepareBrowserEntry(session, { kind: 'attempts' }), ready.ok && ready.isCurrent());
    assert.equal(session._browserEntry, null);
  }
});
test('duplicate activation and stale attempt, generation or signal cannot open a browser', async () => {
  for (const change of [(s,c) => c.abort(), s => s.state.localAttemptId = 'b', s => s._uploadContextGeneration++]) {
    const session = fixture(), controller = new AbortController(); let release;
    session.ensureReadSessionReady = () => new Promise(resolve => { release = resolve; });
    const opening = prepareBrowserEntry(session, { kind: 'published' }, { signal: controller.signal });
    assert.equal(await prepareBrowserEntry(session, { kind: 'attempts' }), false);
    change(session, controller); release({ ok: true, isCurrent: () => true });
    assert.equal(await opening, false); assert.equal(session._browserEntry, null);
  }
});
test('failed readiness releases the opener for a fresh explicit retry', async () => {
  const session = fixture();session.ensureReadSessionReady = async () => { throw Error('failed'); };
  await assert.rejects(prepareBrowserEntry(session, {kind:'attempts'}), /failed/);
  assert.equal(session._browserEntry, null);
});
