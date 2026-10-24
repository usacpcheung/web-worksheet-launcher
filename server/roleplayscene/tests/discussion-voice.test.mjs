import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadAuthFlow } from '../../app/auth/read-auth-flow.js';
import { RolePlaySceneDiscussionSession } from '../scripts/player/discussion-state.js';
import { buildDiscussionPrintModel } from '../scripts/player/discussion-print.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const project = { meta: { title: 'Test' }, scenes: [{ id: 'one' }, { id: 'two' }] };
function setup(options = {}) {
  let stored = ''; let finishCapture;
  const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  let captures = 0, transcriptions = 0;
  const session = new RolePlaySceneDiscussionSession({ getProviderAuth: () => ({ ensure: async () => ({ ok: true, isCurrent: () => true }) }), storage,
    recording: () => ({ start: async () => { captures++; return { ok: true }; },
      result: new Promise(resolve => { finishCapture = resolve; }),
      stop: () => finishCapture({ ok: true, data: { audioBlob: new Blob(['audio']) } }), teardown() {} }),
    apiClient: { transcribeAudio: async () => { transcriptions++; return { ok: true, data: { text: 'new sentence' } }; },
      rewriteText: async text => ({ ok: true, data: { text } }), ...options.api },
    ...options,
  });
  session.bindProject(project);
  return { session, storage, counts: () => ({ captures, transcriptions }) };
}
test('voice inserts after selection and undo preserves long discussion without worksheet limit', async () => {
  const { session } = setup(); const before = 'A'.repeat(400) + ' end';
  session.setText('one', before);
  const task = session.voice.run('one', { intent: { deliberate: true, snapshot: before, index: 400 } });
  await tick(); session.voice.stop(); await task;
  assert.equal(session.getText('one'), 'A'.repeat(400) + ' new sentence end');
  session.undo('one'); assert.equal(session.getText('one'), before);
});
test('navigation stops recording and targets original scene while another remains editable', async () => {
  const { session } = setup();
  const task = session.voice.run('one'); await tick();
  session.voice.navigate(); session.setText('two', 'typing'); await task;
  assert.equal(session.getText('one'), 'new sentence'); assert.equal(session.getText('two'), 'typing');
});
test('session check fails before microphone and another click uses current rewrite source', async () => {
  let ready = false;
  const { session, counts } = setup({ checkSession: async () => ({ ok: ready, error: { code: 'AUTH_REQUIRED' } }) });
  await session.voice.run('one'); assert.equal(counts().captures, 0);
  session.setText('one', 'latest'); ready = true;
  await session.rewrite('one'); assert.equal(session.getText('one'), 'latest');
});
test('cancel releases lock and story replacement rejects late results with reused IDs', async () => {
  let resolve;
  const { session } = setup({ api: { rewriteText: () => new Promise(r => { resolve = r; }) } });
  session.setText('one', 'old'); const task = session.rewrite('one'); await tick();
  session.voice.cancel(); assert.equal(session.voice.active, null);
  session.bindProject({ ...project, meta: { title: 'Different story' } });
  session.setText('one', 'new story'); resolve({ ok: true, data: { text: 'late' } }); await task;
  assert.equal(session.getText('one'), 'new story'); assert.deepEqual(Object.keys(session.recovery), []);
});
test('transcript recovery survives empty editing/reload and retry does not transcribe again', async () => {
  let fail = true;
  const { session, storage, counts } = setup({ api: { rewriteText: async text => fail
    ? { ok: false, error: { code: 'UPSTREAM_FAILED' } } : { ok: true, data: { text } } } });
  const task = session.voice.run('one'); await tick(); session.voice.stop(); await task;
  assert.equal(session.recovery.one.text, 'new sentence');
  assert.equal((await session.rewrite('one')).status, 'recovery_pending');
  session.recovery.one.text = ''; session.persist();
  const restored = new RolePlaySceneDiscussionSession({ getProviderAuth: () => ({ ensure: async () => ({ ok: true, isCurrent: () => true }) }), storage }); restored.bindProject(project);
  assert.equal(restored.recovery.one.phase, 'text'); assert.equal(restored.recovery.one.text, '');
  assert.equal(restored.hasPendingWork(), true);
  session.recovery.one.text = 'edited'; fail = false;
  await session.voice.run('one', { retry: session.recovery.one });
  assert.equal(session.getText('one'), 'edited'); assert.equal(counts().transcriptions, 1);
  assert.equal(JSON.stringify(session.getStoragePayload()).includes('audio'), false);
});
test('storage failure is visible and recovery never becomes printed discussion text', async () => {
  const { session } = setup({ storage: { getItem: () => null, setItem() { throw Error('full'); } } });
  session.setText('one', 'answer'); assert.equal(session.saveFailed, true);
  session.recovery.one = { phase: 'text', text: 'secret recovered segment' };
  assert.equal(JSON.stringify(buildDiscussionPrintModel(project, session.snapshot())).includes('secret recovered segment'), false);
});
test('whole discussion rewrite accepts over 300 and enforces 2000 Unicode code points', async () => {
  let calls = 0;
  const { session } = setup({ api: { rewriteText: async text => { calls++; return { ok: true, data: { text } }; } } });
  session.setText('one', '中'.repeat(301)); await session.rewrite('one'); assert.equal(calls, 1);
  session.setText('one', '😀'.repeat(2000)); await session.rewrite('one'); assert.equal(calls, 2);
  session.setText('one', '😀'.repeat(2001)); await session.rewrite('one'); assert.equal(calls, 2);
});

test('imported property-name IDs support rewrite, undo, recovery reload and retry', async () => {
  for (const id of ['constructor', '__proto__', 'toString']) {
    let stored = null; let fail = false;
    const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
    const apiClient = { rewriteText: async () => fail ? { ok: false, error: { code: 'UPSTREAM_FAILED' } }
      : { ok: true, data: { text: 'Rewritten' } } };
    const unusual = { meta: { title: 'Imported' }, scenes: [{ id }] };
    const session = new RolePlaySceneDiscussionSession({ getProviderAuth: () => ({ ensure: async () => ({ ok: true, isCurrent: () => true }) }), storage, apiClient });
    session.bindProject(unusual);
    assert.equal(session.getMessage(id), '');
    session.setText(id, 'Original');
    assert.equal((await session.rewrite(id)).ok, true);
    assert.equal(session.getText(id), 'Rewritten');
    assert.equal(session.undo(id), true);
    assert.equal(session.getText(id), 'Original');
    fail = true; await session.rewrite(id);
    assert.equal(Object.hasOwn(JSON.parse(stored).recovery, id), true);
    const restored = new RolePlaySceneDiscussionSession({ getProviderAuth: () => ({ ensure: async () => ({ ok: true, isCurrent: () => true }) }), storage, apiClient });
    restored.bindProject(unusual);
    assert.equal(restored.recovery[id].text, 'Original');
    fail = false;
    assert.equal((await restored.voice.run(id, { mode: 'rewrite', retry: restored.recovery[id] })).ok, true);
    assert.equal(restored.getText(id), 'Rewritten');
    assert.equal(restored.hasPendingWork(), false);
    restored.clear();
    assert.equal(Object.getPrototypeOf(restored.recovery), null);
    assert.equal(restored.recovery[id], undefined);
  }
});

test('discussion rewrite preflight failure preserves recovery edits through reload and retry', async () => {
  let ready = false; const sent = [];
  const getProviderAuth = () => ({ ensure: async () => ready
    ? { ok: true, isCurrent: () => true } : { ok: false, error: { code: 'AUTH_REQUIRED' } } });
  const apiClient = { rewriteText: async text => { sent.push(text); return { ok: true, data: { text } }; } };
  const { session, storage } = setup({ getProviderAuth, apiClient });
  session.setText('one', 'Original');
  await session.rewrite('one');
  assert.equal(session.recovery.one.phase, 'text');
  session.recovery.one.text = 'Edited recovery'; session.persist();
  assert.equal((await session.rewrite('one')).status, 'recovery_pending');
  const restored = new RolePlaySceneDiscussionSession({ storage, getProviderAuth, apiClient });
  restored.bindProject(project); ready = true;
  assert.equal(restored.recovery.one.text, 'Edited recovery');
  await restored.voice.run('one', { mode: 'rewrite', retry: restored.recovery.one });
  assert.deepEqual(sent, ['Edited recovery']);
  assert.equal(restored.getText('one'), 'Edited recovery');
  assert.equal(restored.undo('one'), true);
  assert.equal(restored.getText('one'), 'Original');
});


test('discussion expiry after transcription retains sign-in guidance and retries text only', async () => {
  let subject = 'A', probes = 0;
  const auth = createReadAuthFlow({ subject: () => subject,
    invalidate: () => { subject = null; }, prompt: () => false, signIn: () => {},
    probe: async () => {
      const fail = ++probes === 2;
      subject = fail ? null : 'A';
      const result = fail ? { ok: false, status: 'not_ready', error: { code: 'AUTH_REQUIRED' } }
        : { ok: true, status: 'ready', user: { sub: 'A' } };
      auth.observe(result); return result;
    },
  });
  const { session, counts } = setup({ getProviderAuth: () => auth });
  session.setText('one', 'Original');
  const task = session.voice.run('one'); await tick(); session.voice.stop();
  assert.equal((await task).error.code, 'AUTH_REQUIRED');
  assert.equal(session.recovery.one.code, 'AUTH_REQUIRED');
  assert.equal(session.recovery.one.text, 'new sentence');
  assert.equal(session.getText('one'), 'Original');
  assert.equal((await session.voice.run('one', { retry: session.recovery.one })).ok, true);
  assert.equal(session.getText('one'), 'Original new sentence');
  assert.deepEqual(counts(), { captures: 1, transcriptions: 1 });
});
