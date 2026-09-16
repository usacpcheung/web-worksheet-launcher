import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceWorkflow, insertVoiceSegment, insertionIndex, normalizeVoiceRecovery,
  unicodeLength, isVoiceQuestion, AUDIO_UPLOAD_LIMIT } from './answer-voice-workflow.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('recovery normalization accepts own special-name IDs and ignores inherited records', () => {
  const record = { phase: 'text', text: 'Recovered', snapshot: 'Original', index: 8 };
  const records = Object.create({ inherited: record }, Object.getOwnPropertyDescriptors(Object.fromEntries([
    ['__proto__', record], ['constructor', record], ['toString', record],
  ])));
  const blocks = ['__proto__', 'constructor', 'toString', 'inherited'].map(blockId => ({ blockId, kind: 'question' }));
  const normalized = normalizeVoiceRecovery(records, blocks);
  assert.deepEqual(Object.keys(normalized), ['__proto__', 'constructor', 'toString']);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal(JSON.parse(JSON.stringify(normalized)).__proto__.text, 'Recovered');
});
function setup(options = {}) {
  const state = { attempt: 'a', contextKey: {}, editable: true, answers: { q1: 'Earlier', q2: 'Other' },
    recovery: {}, applied: [], states: [], requests: [], records: [], interval: null };
  const flow = createVoiceWorkflow({
    context: blockId => ({ attemptId: state.attempt, contextKey: state.contextKey, editable: state.editable, recovery: state.recovery[blockId],
      block: { blockId, kind: 'question', responseConfig: { inputType: 'text', maxLength: options.maxLength || 200 } },
      answer: state.answers[blockId] }),
    apply: (id, text, snapshot, caret) => { state.answers[id] = text; state.applied.push({ id, text, snapshot, caret }); },
    recover: (id, record) => { if (record) state.recovery[id] = record; else delete state.recovery[id]; },
    changed: () => { state.states.push(flow.active?.state || 'idle'); },
    checkSession: options.checkSession || (async () => ({ ok: true })),
    api: {
      transcribeAudio: async (blob, request) => {
        state.requests.push({ kind: 'transcribe', blob, request });
        return options.transcribe ? options.transcribe(blob, request) : { ok: true, data: { text: 'new segment' } };
      },
      rewriteText: async (text, request) => {
        state.requests.push({ kind: 'rewrite', text, request });
        return options.rewrite ? options.rewrite(text, request) : { ok: true, data: { text: 'New segment' } };
      },
    },
    recording: () => {
      const data = deferred();
      const recorder = { result: data.promise, elapsedSeconds: 3,
        start: options.start || (async () => ({ ok: true })),
        stop: () => data.resolve({ ok: true, data: { audioBlob: options.blob || new Blob(['synthetic audio']) } }),
        teardown() { this.closed = true; data.resolve({ ok: false, error: { code: 'CANCELED' } }); },
      };
      state.records.push(recorder); return recorder;
    },
    setTimer: fn => { state.interval = fn; return 1; }, clearTimer: () => { state.interval = null; },
  });
  return { state, flow, async record() { const pending = flow.run('q1'); await tick(); flow.stop(); return pending; } };
}

test('insertion defaults to end, uses deliberate selection end, and avoids surrogate splitting', () => {
  assert.equal(insertionIndex('abc', { index: 0 }), 3);
  assert.equal(insertionIndex('abc', { deliberate: true, snapshot: 'abc', index: 1 }), 1);
  assert.equal(insertionIndex('abc', { deliberate: true, snapshot: 'changed', index: 1 }), 3);
  assert.equal(insertionIndex('abc', { deliberate: true, snapshot: 'abc', index: 99 }), 3);
  assert.equal(insertionIndex('a😀b', { deliberate: true, snapshot: 'a😀b', index: 2 }), 3);
  assert.equal(insertVoiceSegment('first last', 'middle', 6).text, 'first middle last');
  assert.equal(insertVoiceSegment('中文', '補充', 1).text, '中補充文');
  assert.equal(insertVoiceSegment('first\nlast', '補充', 6).text, 'first\n補充last');
  assert.equal(insertVoiceSegment('abc', 'X', 2).text, 'ab X c');
  assert.equal(unicodeLength('😀中a'), 3);
});

test('only text questions are eligible', () => {
  for (const inputType of ['number', 'boolean', 'multiple_choice']) assert.equal(isVoiceQuestion({ kind: 'question', responseConfig: { inputType } }), false);
  assert.equal(isVoiceQuestion({ kind: 'content' }), false);
  assert.equal(isVoiceQuestion({ kind: 'question' }), true);
});

test('voice pipeline rewrites only the transcript, appends, and repeats after typing', async () => {
  const { flow, state, record } = setup();
  assert.equal((await record()).ok, true);
  assert.equal(state.answers.q1, 'Earlier New segment');
  assert.equal(state.requests[1].text, 'new segment');
  assert.equal(state.applied[0].snapshot, 'Earlier');
  assert.equal(state.applied[0].caret, state.answers.q1.length);
  state.answers.q1 += '. Typed';
  await record();
  assert.equal(state.answers.q1, 'Earlier New segment. Typed New segment');
  assert.equal(state.answers.q2, 'Other');
  assert.equal(flow.active, null); assert.equal(state.interval, null);
  assert.ok(state.states.includes('recording') && state.states.includes('transcribing') && state.states.includes('rewriting'));
});

test('one active operation blocks other questions and navigation stops recording', async () => {
  const { flow, state } = setup(); const pending = flow.run('q1'); await tick();
  assert.equal((await flow.run('q2', { mode: 'rewrite' })).ok, false);
  assert.equal(state.records.length, 1);
  flow.navigate(); await pending;
  assert.equal(state.answers.q2, 'Other'); assert.equal(state.requests.length, 2);
});

for (const stage of ['checking_session', 'requesting_permission', 'transcribing', 'rewriting']) {
  test(`cancel during ${stage} settles promptly and late completion cannot mutate answers`, async () => {
    const wait = deferred();
    const options = stage === 'checking_session' ? { checkSession: () => wait.promise }
      : stage === 'requesting_permission' ? { start: () => wait.promise }
        : stage === 'transcribing' ? { transcribe: () => wait.promise } : { rewrite: () => wait.promise };
    const { flow, state } = setup(options);
    const pending = flow.run('q1'); await tick();
    if (['transcribing', 'rewriting'].includes(stage)) { flow.stop(); await tick(); }
    assert.equal(flow.active.state, stage);
    flow.cancel();
    await pending;
    assert.equal(state.answers.q1, 'Earlier'); assert.equal(flow.active, null);
    wait.resolve({ ok: true, data: { text: 'late' } }); await tick();
    assert.equal(state.answers.q1, 'Earlier');
  });
}

test('permission cancellation does not clear a newer operation', async () => {
  const permission = deferred(); const { flow, state } = setup({ start: () => permission.promise });
  const old = flow.run('q1'); await tick(); flow.cancel(); await old;
  const next = flow.run('q2', { mode: 'rewrite' }); await next;
  permission.resolve({ ok: true }); await tick();
  assert.equal(state.answers.q1, 'Earlier'); assert.equal(state.answers.q2, 'New segment');
  assert.ok(state.records[0].closed);
});

for (const change of ['answer', 'attempt', 'submission', 'snapshot']) {
  test(`${change} change prevents late insertion`, async () => {
    const wait = deferred(); const { flow, state } = setup({ rewrite: () => wait.promise });
    const pending = flow.run('q1'); await tick(); flow.stop(); await tick();
    if (change === 'answer') state.answers.q1 = 'Updated';
    if (change === 'attempt') state.attempt = 'b';
    if (change === 'submission') state.editable = false;
    if (change === 'snapshot') state.contextKey = {};
    wait.resolve({ ok: true, data: { text: 'Late result' } }); await pending;
    assert.equal(state.applied.length, 0);
    if (change === 'answer') assert.equal(state.recovery.q1.code, 'STALE_CONTEXT');
  });
}

test('rewrite failure retains transcript and retry does not transcribe again', async () => {
  let fail = true;
  const { flow, state, record } = setup({ rewrite: async () => fail
    ? { ok: false, error: { code: 'UNKNOWN_UPSTREAM', message: 'private' } }
    : { ok: true, data: { text: 'Recovered' } } });
  await record(); assert.equal(state.recovery.q1.text, 'new segment');
  assert.equal(state.recovery.q1.code, 'REWRITE_FAILED');
  assert.equal(flow.lastDiagnostic.upstreamCode, 'UNKNOWN_UPSTREAM');
  assert.ok(!JSON.stringify(flow.lastDiagnostic).includes('private'));
  assert.ok(!JSON.stringify(state.recovery).includes('private'));
  fail = false; await flow.run('q1', { retry: state.recovery.q1 });
  assert.equal(state.requests.filter(r => r.kind === 'transcribe').length, 1);
  assert.equal(state.answers.q1, 'Earlier Recovered'); assert.equal(state.recovery.q1, undefined);
});

test('transcript limit counts Unicode, and oversized transcript is not sent to rewrite', async () => {
  const h = setup({ transcribe: async () => ({ ok: true, data: { text: '😀'.repeat(2001) } }) });
  await h.record(); assert.equal(h.state.recovery.q1.code, 'TRANSCRIPT_TOO_LONG');
  assert.equal(h.state.requests.length, 1);
  const accepted = setup({ rewrite: async () => ({ ok: true, data: { text: 'Short' } }) });
  accepted.state.answers.q1 = '😀'.repeat(2000);
  assert.equal((await accepted.flow.run('q1', { mode: 'rewrite' })).ok, true);
});

test('combined length overflow retains full candidate and permits local shortening', async () => {
  const { flow, state, record } = setup({ maxLength: 10 }); await record();
  assert.equal(state.answers.q1, 'Earlier');
  assert.equal(state.recovery.q1.candidate, 'New segment');
  assert.equal(state.recovery.q1.code, 'ANSWER_TOO_LONG');
  await flow.run('q1', { retry: state.recovery.q1, candidate: 'OK' });
  assert.equal(state.answers.q1, 'Earlier OK'); assert.equal(state.requests.length, 2);
});

test('oversized audio is rejected before any upload', async () => {
  const h = setup({ blob: { size: AUDIO_UPLOAD_LIMIT + 1 } }); await h.record();
  assert.equal(h.state.recovery.q1.code, 'UPLOAD_TOO_LARGE'); assert.equal(h.state.requests.length, 0);
});

test('auth before capture never opens microphone; auth at upload retains audio only in memory', async () => {
  const denied = setup({ checkSession: async () => ({ ok: false, error: { code: 'AUTH_REQUIRED' } }) });
  await denied.flow.run('q1'); assert.equal(denied.state.records.length, 0);
  let expired = true;
  const h = setup({ transcribe: async () => expired ? { ok: false, error: { status: 401 } }
    : { ok: true, data: { text: 'recovered' } } });
  await h.record(); assert.equal(h.state.recovery.q1.code, 'AUTH_REQUIRED');
  assert.equal(JSON.stringify(h.state.recovery).includes('blob'), false);
  expired = false; await h.flow.run('q1', { retry: h.state.recovery.q1 });
  assert.equal(h.state.records.length, 1); assert.equal(h.state.requests.length, 3);
});

test('local recovery normalization excludes audio, candidate and diagnostics', () => {
  const record = { text: 'raw fixture', candidate: 'candidate', blob: new Blob(), controller: {},
    snapshot: 'original', index: 2, mode: 'voice', createdAt: 'fixture', details: 'private' };
  const normalized = normalizeVoiceRecovery({ q1: record, q2: record }, [{ kind: 'question', blockId: 'q1' }]);
  assert.deepEqual(normalized, { q1: { phase: 'text', text: 'raw fixture', snapshot: 'original', index: 2, mode: 'voice', createdAt: 'fixture' } });
});

test('empty rewrite output keeps the original answer and recoverable source', async () => {
  const h = setup({ rewrite: async () => ({ ok: true, data: { text: '   ' } }) });
  assert.equal((await h.flow.run('q1', { mode: 'rewrite' })).ok, false);
  assert.equal(h.state.answers.q1, 'Earlier');
  assert.equal(h.state.recovery.q1.text, 'Earlier');
});

test('restored invalid insertion index safely appends and does not split Unicode', async () => {
  const h = setup();
  await h.flow.run('q1', { retry: { snapshot: 'Earlier', text: 'raw', index: -1 }, candidate: 'OK' });
  assert.equal(h.state.answers.q1, 'Earlier OK');
  h.state.answers.q1 = 'a😀b';
  await h.flow.run('q1', { retry: { snapshot: 'a😀b', text: 'raw', index: 2 }, candidate: '中' });
  assert.equal(h.state.answers.q1, 'a😀中b');
});

test('unresolved recovery blocks new work until retry or discard, even after clearing text', async () => {
  const h = setup({ rewrite: async () => ({ ok: false, error: { code: 'UPSTREAM_ERROR' } }) });
  await h.record();
  const previous = h.state.recovery.q1;
  assert.equal((await h.flow.run('q1', { mode: 'rewrite' })).status, 'recovery_pending');
  assert.equal(h.state.recovery.q1, previous);
  previous.text = '';
  assert.equal((await h.flow.run('q1')).status, 'recovery_pending');
  assert.equal((await h.flow.run('q1', { retry: previous })).status, 'empty_source');
  assert.equal(h.state.records.length, 1);
  assert.equal(h.state.requests.length, 2);
  const normalized = normalizeVoiceRecovery(h.state.recovery, [{kind:'question',blockId:'q1'}]);
  assert.equal(normalized.q1.phase, 'text');
  assert.equal(normalized.q1.text, '');
  h.flow.discard('q1');
  await h.flow.run('q1', {mode:'rewrite'});
  assert.equal(h.state.requests.length, 3);
});

test('preflight failure ends whole rewrite; a new click uses the current answer after sign-in', async () => {
  let ready = false;
  const h = setup({ checkSession: async () => ({ok:ready,error:{code:'AUTH_REQUIRED'}}) });
  await h.flow.run('q1', {mode:'rewrite'});
  assert.equal(h.state.recovery.q1.phase, 'preflight');
  assert.equal(h.state.requests.length, 0);
  ready = true;
  h.state.answers.q1 = 'Edited while signing in';
  await h.flow.run('q1', {mode:'rewrite'});
  assert.equal(h.state.requests[0].text, 'Edited while signing in');
  assert.equal(h.state.records.length, 0);
  assert.equal(h.state.recovery.q1, undefined);
});

test('sentence boundaries preserve punctuation, whitespace and Chinese without joining Latin words', () => {
  for (const [left,right,expected] of [
    ['I took a bus.','Then I walked.','I took a bus. Then I walked.'],
    ['A café.','Élodie arrived.','A café. Élodie arrived.'],
    ['Done!','Next','Done! Next'],
    ['Done.\n','Next','Done.\nNext'],
    ['中文。','補充。','中文。補充。'],
    ['Hello',' world','Hello world']
  ]) assert.equal(insertVoiceSegment(left,right,left.length).text,expected);
});
