import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const start = source.indexOf('async function resumeViewerReadReturn(');
const end = source.indexOf('\nfunction renderViewerShell', start);
function fixture(kind, overrides = {}) {
  const events = [];
  const session = {
    _readAuthReturn: { subject: 'a', localId: 'old', readIntent: { kind, id: 'resource' } },
    state: { localAttemptId: 'old' },
    probeServerSessionSilently: async () => ({ ok: true, user: { sub: 'a' } }),
    startFromPublishedPackage: async () => { events.push('open'); session.state.localAttemptId = 'new'; return { ok: true }; },
    resumeUploadedAttempt: async () => { events.push('resume'); session.state.localAttemptId = 'new'; return { ok: true }; },
    downloadUploadedAttempt: async () => { events.push('download'); return { ok: true }; },
    setRecoveryMessage: message => events.push(message),
    notifyStateChange: () => events.push('notify'), ...overrides,
  };
  const context = vm.createContext({ URL, window: { location: { href: 'https://example.test/viewer/?snapshot=old' }, history: { replaceState: (_a,_b,url) => events.push(String(url)) } },
    t: key => key, getApiErrorMessage: () => 'localized-failure', renderViewerShell: () => events.push('render'),
    showPublishedPackagesBrowseModal: () => events.push('browse'),
    showUploadedAttemptsManagerModal: async (_session, options) => { events.push('manager'); await options.onResumeSuccess(); },
  });
  vm.runInContext(source.slice(start,end), context);
  return { session, events, run: () => context.resumeViewerReadReturn(session) };
}
test('same-tab publication and attempt return render the restored worksheet and update its URL once', async () => {
  for (const kind of ['publication','attempt']) {
    const h = fixture(kind); await h.run(); await h.run();
    assert.equal(h.events[0], kind === 'publication' ? 'open' : 'resume');
    assert.equal(h.events[1], 'https://example.test/viewer/?localAttemptId=new');
    assert.equal(h.events[2], 'render'); assert.equal(h.events.length,3);
  }
});
test('return manager preserves its resume callback; download never replaces the worksheet', async () => {
  const manager = fixture('attempts'); await manager.run(); assert.ok(manager.events.includes('render'));
  const download = fixture('attempt-download'); await download.run(); assert.deepEqual(download.events,['download']);
});
test('account/context mismatch and exceptions cannot replay a restored action', async () => {
  for (const overrides of [{ probeServerSessionSilently: async () => ({ok:true,user:{sub:'b'}}) }, { state: { localAttemptId: 'different' } }]) {
    const h = fixture('publication',overrides); await h.run(); assert.deepEqual(h.events,['readAuth.accountChanged', 'notify']);
  }
  const h=fixture('publication',{startFromPublishedPackage:async()=>{throw Error('offline');}});
  await h.run(); assert.deepEqual(h.events,['localized-failure', 'notify']);
});

test('mutation return updates visible guidance without invoking upload or deletion', async () => {
  for (const operation of ['upload','delete-attempt']) {
    const h = fixture('mutation', { notifyStateChange: () => h.events.push('notify') });
    h.session._readAuthReturn.readIntent.operation = operation;
    h.session.uploadCurrentAttemptPackage = () => assert.fail('return must not upload');
    h.session.deleteUploadedAttemptAndRefresh = () => assert.fail('return must not delete');
    await h.run();
    assert.deepEqual(h.events.slice(0,2), ['mutationAuth.returned','notify']);
    assert.equal(h.events.includes('manager'),operation==='delete-attempt');
  }
});

test('failed return verification displays guidance and cannot replay any action', async () => {
  for (const code of ['AUTH_REQUIRED', 'FORBIDDEN', 'NETWORK_ERROR']) {
    const h = fixture('mutation', { probeServerSessionSilently: async () => ({ ok: false, error: { code } }) });
    await h.run(); await h.run();
    assert.deepEqual(h.events, ['localized-failure', 'notify']);
    assert.equal(h.session._readAuthReturn, null);
  }
});

test('superseded verification and context changes cannot reopen a manager or show stale guidance', async () => {
  for (const result of [{ ok: false, skipped: true }, { ok: false, cancelled: true }]) {
    const h = fixture('attempts', { probeServerSessionSilently: async () => result });
    await h.run(); assert.deepEqual(h.events, []);
  }
  for (const change of [session => { session.state.localAttemptId = 'new'; },
    session => { session._uploadContextGeneration = 1; }]) {
    let release;
    const h = fixture('attempts', { probeServerSessionSilently: () => new Promise(resolve => { release = resolve; }) });
    const work = h.run(); change(h.session); release({ ok: true, user: { sub: 'a' } });
    await work; assert.deepEqual(h.events, []);
  }
});

test('a rejected verification cannot publish an error after context replacement', async () => {
  let reject;
  const h = fixture('attempts', { probeServerSessionSilently: () => new Promise((_resolve, fail) => { reject = fail; }) });
  const work = h.run(); h.session.state.localAttemptId = 'replacement'; reject(Error('offline'));
  await work; assert.deepEqual(h.events, []);
});
