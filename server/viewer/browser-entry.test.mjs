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

const feedbackFixture = () => {
  const notices = new Map();
  const session = { ...fixture(),
    setNotificationForSource: (source, notice) => notices.set(source, notice),
    clearNotificationsBySource: source => notices.delete(source),
  };
  return { session, notices };
};

test('checking feedback is immediate, unique and removed for every readiness outcome', async () => {
  for (const outcome of ['success', 'cancel', 'failure', 'throw']) {
    const { session, notices } = feedbackFixture();
    let resolve, reject;
    session.ensureReadSessionReady = () => new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = prepareBrowserEntry(session, { kind: 'attempts' });
    assert.equal(notices.size, 1);
    assert.equal([...notices.values()][0].kind, 'info');
    assert.ok([...notices.values()][0].text);
    assert.equal(await prepareBrowserEntry(session, { kind: 'published' }), false);
    assert.equal(notices.size, 1);
    if (outcome === 'throw') {
      reject(new Error('offline'));
      await assert.rejects(pending, /offline/);
    } else {
      resolve(outcome === 'success' ? { ok: true, isCurrent: () => true }
        : { ok: false, result: { cancelled: outcome === 'cancel' } });
      assert.equal(await pending, outcome === 'success');
    }
    assert.equal(notices.size, 0);
    assert.equal(session._browserEntry, null);
  }
});

test('consent handoff clears only the checking notice and preserves the entry guard', async () => {
  const { session, notices } = feedbackFixture();
  notices.set('unrelated', { text: 'Keep existing warning' });
  session.ensureReadSessionReady = async () => {
    session._browserEntry.clearFeedback();
    assert.equal(notices.size, 1);
    assert.equal(await prepareBrowserEntry(session, { kind: 'published' }), false);
    return { ok: false, result: { cancelled: true } };
  };
  assert.equal(await prepareBrowserEntry(session, { kind: 'attempts' }), false);
  assert.deepEqual([...notices.keys()], ['unrelated']);
});

test('abort clears feedback immediately and an old completion cannot clear a newer entry', async () => {
  const { session, notices } = feedbackFixture();
  const replies = [];
  session.ensureReadSessionReady = () => new Promise(resolve => replies.push(resolve));
  const controller = new AbortController();
  const old = prepareBrowserEntry(session, { kind: 'attempts' }, { signal: controller.signal });
  controller.abort();
  assert.equal(notices.size, 0);
  assert.equal(session._browserEntry, null);
  const fresh = prepareBrowserEntry(session, { kind: 'published' });
  const currentOwner = session._browserEntry;
  const currentSources = [...notices.keys()];
  replies[0]({ ok: true, isCurrent: () => true });
  assert.equal(await old, false);
  assert.equal(session._browserEntry, currentOwner);
  assert.deepEqual([...notices.keys()], currentSources);
  replies[1]({ ok: true, isCurrent: () => true });
  assert.equal(await fresh, true);
  assert.equal(notices.size, 0);
});


test('a new entry clears its previous failure without clearing unrelated notices', async () => {
  const { session, notices } = feedbackFixture();
  session.pushNotification = notice => notices.set(notice.source, notice);
  session.state.serverActionMessage = 'Service unavailable';
  session.ensureReadSessionReady = async () => ({ ok: false, result: {} });
  await prepareBrowserEntry(session, { kind: 'attempts' });
  assert.equal(notices.size, 1);
  assert.equal([...notices.values()][0].kind, 'error');
  notices.set('unrelated', { text: 'Keep existing warning' });
  session.ensureReadSessionReady = async () => {
    assert.equal([...notices.values()].some(notice => notice.kind === 'error'), false);
    return { ok: true, isCurrent: () => true };
  };
  assert.equal(await prepareBrowserEntry(session, { kind: 'attempts' }), true);
  assert.deepEqual([...notices.keys()], ['unrelated']);
});
