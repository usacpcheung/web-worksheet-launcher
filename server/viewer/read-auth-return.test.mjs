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
    setRecoveryMessage: message => events.push(message), ...overrides,
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
    const h = fixture('publication',overrides); await h.run(); assert.deepEqual(h.events,['readAuth.accountChanged']);
  }
  const h=fixture('publication',{startFromPublishedPackage:async()=>{throw Error('offline');}});
  await h.run(); assert.deepEqual(h.events,['localized-failure']);
});
