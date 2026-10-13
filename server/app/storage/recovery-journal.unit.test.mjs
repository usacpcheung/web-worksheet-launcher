import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecovery, writeRecovery, withRecovery, installPageRecovery } from './recovery-journal.js';
const record = (title, second = 2) => ({ localId: 'draft', title, metadata: { localId: 'draft', origin: 'local_created', updatedAt: `2026-10-13T00:00:0${second}.000Z` } });
function storage(t) {
  const data = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: k => data.get(k) || null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k), key: i => [...data.keys()][i], get length() { return data.size; } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; });
  return data;
}
test('reload restores pending edits and clears the journal only after persistence succeeds', async t => {
  storage(t); let saved = record('old', 1); let fail = true;
  const api = withRecovery('localDrafts', { get: async () => saved, put: async r => { if (fail) throw Error('quota'); saved=r; return r; } });
  writeRecovery('localDrafts',record('new'));
  assert.equal((await api.get('draft')).title,'new');
  assert.equal(readRecovery('localDrafts','draft').title,'new');
  fail=false; assert.equal((await api.get('draft')).title,'new');
  assert.equal(readRecovery('localDrafts','draft'),null);
  assert.equal(saved.title,'new');
});
test('old writes cannot clear newer recovery and newer persisted records win', async t => {
  storage(t);const api=withRecovery('localDrafts',{put:async r=>r,get:async()=>record('newest',3)});
  writeRecovery('localDrafts',record('pending',2));await api.put(record('old',1));
  assert.equal(readRecovery('localDrafts','draft').title,'pending');
  assert.equal((await api.get('draft')).title,'newest');assert.equal(readRecovery('localDrafts','draft'),null);
});
test('pending records remain recoverable when IndexedDB cannot be read', async t => {
  storage(t);writeRecovery('localDrafts',record('recoverable'));
  const api=withRecovery('localDrafts',{get:async()=>{throw Error('unavailable');},put:async()=>{throw Error('unavailable');}});
  assert.equal((await api.get('draft')).title,'recoverable');
});
test('different edits in the same millisecond keep the pending recovery record', async t => {
  storage(t);
  let saved = record('old');
  const api = withRecovery('localDrafts', { get: async () => saved, put: async r => { saved = r; return r; } });
  writeRecovery('localDrafts', record('new'));
  await api.put(record('old'));
  assert.equal(readRecovery('localDrafts', 'draft').title, 'new');
  assert.equal((await api.get('draft')).title, 'new');
  assert.equal(saved.title, 'new');
});
test('page leave journals synchronously; unavailable journal requests navigation confirmation', t => {
  const data=storage(t);const target=new EventTarget(), doc=new EventTarget();let saves=0;
  const session={state:{autosavePending:true},createRecoveryRecord:()=>record('latest'),autosave:async()=>{saves++;}};
  const dispose=installPageRecovery('localDrafts',()=>session,target,doc);
  const leave=new Event('beforeunload',{cancelable:true});target.dispatchEvent(leave);
  assert.equal(readRecovery('localDrafts','draft').title,'latest');assert.equal(leave.defaultPrevented,false);assert.equal(saves,1);
  data.clear();globalThis.sessionStorage.setItem=()=>{throw Error('quota');};
  const blocked=new Event('beforeunload',{cancelable:true});target.dispatchEvent(blocked);assert.equal(blocked.defaultPrevented,true);
  dispose();target.dispatchEvent(new Event('pagehide'));assert.equal(saves,2);
});
test('successful record deletion removes recovery so it cannot resurrect a deleted draft', async t => {
  storage(t);writeRecovery('localDrafts',record('deleted'));
  const api=withRecovery('localDrafts',{remove:async()=>{}});await api.remove('draft');assert.equal(readRecovery('localDrafts','draft'),null);
});

test('a recovery read must not overwrite a save completed while its database read was pending', async t => {
  storage(t);
  let saved = record('old', 1), finishRead;
  const api = withRecovery('localDrafts', {
    get: () => new Promise(resolve => { const snapshot = saved; finishRead = () => resolve(snapshot); }),
    put: async value => { saved = value; return value; },
  });
  writeRecovery('localDrafts', record('journal', 2));
  const reading = api.get('draft');
  await api.put(record('latest save', 3));
  finishRead(); await reading;
  assert.equal(saved.title, 'latest save');
});

test('a pending recovery read cannot resurrect a record removed in the meantime', async t => {
  storage(t);
  let saved = record('old', 1), finishRead;
  const api = withRecovery('localDrafts', {
    get: () => new Promise(resolve => { const snapshot = saved; finishRead = () => resolve(snapshot); }),
    put: async value => { saved = value; return value; },
    remove: async () => { saved = null; },
  });
  writeRecovery('localDrafts', record('journal', 2));
  const reading = api.get('draft');
  await api.remove('draft');
  finishRead(); await reading;
  assert.equal(saved, null);
});

test('a failed initial read cannot consume recovery using an unknown comparison base', async t => {
  storage(t); writeRecovery('localDrafts', record('latest edits', 2));
  let recoverCalls = 0;
  const api = withRecovery('localDrafts', {
    get: async () => { throw Error('temporary read failure'); },
    recover: async () => { recoverCalls++; return record('old', 1); },
  });
  assert.equal((await api.get('draft')).title, 'latest edits');
  assert.equal(recoverCalls, 0);
  assert.equal(readRecovery('localDrafts', 'draft').title, 'latest edits');
});
