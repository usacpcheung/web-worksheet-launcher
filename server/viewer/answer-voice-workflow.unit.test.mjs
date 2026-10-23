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
    getProviderAuth: options.getProviderAuth || (() => ({ ensure: async () => {
      const ready = options.checkSession ? await options.checkSession() : { ok: true };
      return { ...(ready.result || ready), isCurrent: () => true };
    } })),
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
  assert.equal(flow.lastDiagnostic.upstreamCode, 'API_ERROR');
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

test('rewrite preflight failure preserves edited recovery and requires explicit retry', async () => {
  let ready = false;
  const h = setup({ checkSession: async () => ({ok:ready,error:{code:'AUTH_REQUIRED'}}) });
  await h.flow.run('q1', {mode:'rewrite'});
  assert.equal(h.state.recovery.q1.phase, 'text');
  assert.equal(h.state.requests.length, 0);
  h.state.recovery.q1.text = 'Edited recovery';
  ready = true;
  assert.equal((await h.flow.run('q1', {mode:'rewrite'})).status, 'recovery_pending');
  assert.equal(h.state.recovery.q1.text, 'Edited recovery');
  await h.flow.run('q1', {mode:'rewrite', retry: h.state.recovery.q1});
  assert.equal(h.state.requests[0].text, 'Edited recovery');
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


test('superseded session preflight releases voice/rewrite without fabricated authentication errors', async () => {
  for (const mode of ['voice', 'rewrite']) {
    const {flow,state}=setup({checkSession:async()=>({ok:false,result:{ok:false,skipped:true,status:'superseded'}})});
    assert.equal((await flow.run('q1',{mode})).status,'superseded');
    assert.equal(flow.active,null);
    assert.equal(state.answers.q1,'Earlier');
    assert.deepEqual(state.recovery,{});
    assert.deepEqual(state.requests,[]);
    assert.deepEqual(state.records,[]);
  }
});

for (const change of ['account', 'signout']) {
  test(`shared rewrite discards late output after ${change} and releases lock`, async () => {
    const { createReadAuthFlow } = await import('../app/auth/read-auth-flow.js');
    let subject = 'a'; const pending = deferred();
    const auth = createReadAuthFlow({ subject: () => subject, invalidate() {},
      probe: async () => ({ ok: true, status: 'ready', user: { sub: subject } }),
      prompt: () => assert.fail('no implicit login'), signIn: () => assert.fail(),
    });
    const h = setup({ getProviderAuth: () => auth, rewrite: () => pending.promise });
    const task = h.flow.run('q1', { mode: 'rewrite' }); await tick();
    assert.equal(h.state.requests.length, 1);
    if (change === 'account') { subject = 'b'; auth.observe({ ok: true, status: 'ready', user: { sub: subject } }); }
    else auth.observe({ ok: false, error: { code: 'AUTH_REQUIRED' } });
    pending.resolve({ ok: true, data: { text: 'must not apply' } });
    assert.equal((await task).ok, false);
    assert.equal(h.state.answers.q1, 'Earlier'); assert.equal(h.flow.active, null);
    assert.equal(h.state.recovery.q1.candidate, undefined);
  });
}

test('rewrite preflight uses shared coordinator without login or provider replay', async () => {
  const { createReadAuthFlow } = await import('../app/auth/read-auth-flow.js');
  let ready = false;
  const auth = createReadAuthFlow({ subject: () => ready ? 'a' : null, invalidate() {},
    probe: async () => ready ? { ok: true, status: 'ready', user: { sub: 'a' } } : { ok: false, error: { code: 'AUTH_REQUIRED' } },
    prompt: () => assert.fail('adapter owns sign-in'), signIn: () => assert.fail(),
  });
  const h = setup({ getProviderAuth: () => auth });
  assert.equal((await h.flow.run('q1', { mode: 'rewrite' })).error.code, 'AUTH_REQUIRED');
  assert.equal(h.state.requests.length, 0); ready = true;
  await tick(); assert.equal(h.state.requests.length, 0);
  assert.equal((await h.flow.run('q1', { mode: 'rewrite', retry: h.state.recovery.q1 })).ok, true);
  assert.equal(h.state.requests.length, 1);
});

test('rewrite forbidden does not request sign-in and retains safe shared presentation', async () => {
  const h = setup({ rewrite: async () => ({ ok: false, error: { code: 'FORBIDDEN', status: 403, requiresSignIn: true, message: 'private text' } }) });
  const result = await h.flow.run('q1', { mode: 'rewrite' });
  assert.equal(result.error.code, 'FORBIDDEN'); assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.recovery.q1.providerError.error.requiresSignIn, false);
  assert.equal(JSON.stringify(h.state.recovery).includes('private text'), false);
});

test('recovered candidate cannot be inserted after its account guard expires', async () => {
  let current = true;
  const h = setup({ maxLength: 8, getProviderAuth: () => ({ ensure: async () => ({ ok: true, isCurrent: () => current }) }) });
  await h.record(); assert.equal(h.state.recovery.q1.code, 'ANSWER_TOO_LONG');
  current = false; h.state.answers.q1 = 'Changed';
  await h.flow.run('q1', { retry: h.state.recovery.q1, candidate: 'X' });
  assert.equal(h.state.answers.q1, 'Changed'); assert.equal(h.state.recovery.q1.candidate, undefined);
});

test('rewrite cannot bypass preparation through legacy skipSession or missing auth adapter', async () => {
  const h = setup({ getProviderAuth: () => undefined });
  assert.equal((await h.flow.run('q1', { mode: 'rewrite', skipSession: true })).ok, false);
  assert.equal(h.state.requests.length, 0);
});

for (const cancel of [false, true]) {
  test(`navigation during post-transcription verification preserves original target; explicit cancel=${cancel}`, async () => {
    const gate = deferred();
    let probes = 0;
    const h = setup({ getProviderAuth: () => ({ ensure: () => ++probes === 1
      ? Promise.resolve({ ok: true, isCurrent: () => true }) : gate.promise }) });
    const pending = h.record(); await tick();
    assert.equal(h.flow.active.state, 'checking_session');
    h.flow.navigate();
    assert.ok(h.flow.active, 'background verification survives navigation');
    h.state.answers.q2 = 'New unrelated answer';
    if (cancel) h.flow.cancel();
    gate.resolve({ ok: true, isCurrent: () => true });
    const result = await pending;
    assert.equal(result.ok, !cancel);
    assert.equal(h.state.answers.q1, cancel ? 'Earlier' : 'Earlier New segment');
    assert.equal(h.state.answers.q2, 'New unrelated answer');
    assert.equal(h.state.requests.filter(r => r.kind === 'rewrite').length, cancel ? 0 : 1);
  });
}

for (const candidate of [undefined, 'Recovered']) {
  test(`append replaces legacy Undo snapshot with current answer; candidate=${candidate !== undefined}`, async () => {
    const h = setup(); h.state.answers.q1 = 'New answer';
    const retry = { phase: 'text', mode: 'rewrite', text: 'Original source', snapshot: 'Original', undoSnapshot: 'Old pre-login answer' };
    await h.flow.run('q1', { mode: 'voice', append: true, retry, candidate });
    assert.equal(h.state.applied[0].snapshot, 'New answer');
    assert.equal(h.state.answers.q1, candidate ? 'New answer Recovered' : 'New answer New segment');
  });
}

for (const kind of ['account', 'target', 'answer', 'cancel']) {
  test(`transcription ignores late completion after ${kind} changes`, async () => {
    const gate = deferred(); let identity = true;
    const h = setup({
      getProviderAuth: () => ({ captureIdentity: () => () => identity,
        ensure: async () => ({ ok: true, isCurrent: () => identity }) }),
      transcribe: () => gate.promise,
    });
    const pending = h.record(); await tick();
    assert.equal(h.state.requests.length, 1);
    if (kind === 'account') identity = false;
    if (kind === 'target') h.state.contextKey = {};
    if (kind === 'answer') h.state.answers.q1 = 'New typing';
    if (kind === 'cancel') h.flow.cancel();
    gate.resolve({ ok: true, data: { text: 'Stale transcript' } });
    assert.equal((await pending).ok, false);
    assert.equal(h.state.applied.length, 0);
    assert.equal(h.state.requests.filter(r => r.kind === 'rewrite').length, 0);
    assert.notEqual(h.state.recovery.q1?.text, 'Stale transcript');
    assert.equal(h.state.recovery.q1?.providerError, undefined);
    assert.equal(h.flow.active, null);
  });
}

for (const [upstream, code] of [['FORBIDDEN', 'FORBIDDEN'], ['NETWORK_ERROR', 'TRANSCRIPTION_FAILED'],
  ['RATE_LIMITED', 'RATE_LIMITED'], ['UPLOAD_TOO_LARGE', 'UPLOAD_TOO_LARGE'], ['API_ERROR', 'TRANSCRIPTION_FAILED']]) {
  test(`transcription ${upstream} uses safe shared outcomes without opening login`, async () => {
    let observed = 0;
    const h = setup({
      getProviderAuth: () => ({ ensure: async () => ({ ok: true, isCurrent: () => true }), observe: () => observed++ }),
      transcribe: async () => ({ ok: false, error: { code: upstream, message: 'PRIVATE PROVIDER BODY', details: { audio: 'PRIVATE' } } }),
    });
    const result = await h.record();
    assert.equal(result.error.code, code);
    assert.equal(observed, 0);
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.state.recovery.q1.providerError.operation, 'transcription');
    assert.equal(JSON.stringify(h.state.recovery).includes('PRIVATE'), false);
  });
}

test('transcription preparation failure sends no audio and explicit same-account retry reuses recording', async () => {
  let ready = false, observed = 0;
  const h = setup({ getProviderAuth: () => ({
    captureIdentity: () => () => true,
    ensure: async () => ready ? { ok: true, isCurrent: () => true }
      : { ok: false, error: { code: 'AUTH_REQUIRED' } },
    observe: () => observed++,
  }) });
  assert.equal((await h.record()).error.code, 'AUTH_REQUIRED');
  assert.equal(h.state.requests.length, 0);
  assert.equal(observed, 1);
  ready = true;
  assert.equal((await h.flow.run('q1', { retry: h.state.recovery.q1 })).ok, true);
  assert.equal(h.state.records.length, 1);
  assert.deepEqual(h.state.requests.map(r => r.kind), ['transcribe', 'rewrite']);
});

test('audio retained for authentication retry cannot cross a verified account switch', async () => {
  let account = 'A';
  const h = setup({ getProviderAuth: () => ({
    captureIdentity: () => { const original = account; return () => account === original; },
    ensure: async () => ({ ok: true, isCurrent: () => true }),
  }), transcribe: async () => ({ ok: false, error: { code: 'AUTH_REQUIRED' } }) });
  await h.record(); account = 'B';
  const result = await h.flow.run('q1', { retry: h.state.recovery.q1 });
  assert.equal(result.status, 'superseded');
  assert.equal(h.state.records.length, 1);
  assert.equal(h.state.requests.length, 1);
});

test('account change after transcription but before rewrite prevents sending retained text', async () => {
  let account = true, probes = 0;
  const h = setup({ getProviderAuth: () => ({
    captureIdentity: () => () => account,
    ensure: async () => {
      if (++probes === 2) account = false;
      return { ok: true, isCurrent: () => true };
    },
  }) });
  assert.equal((await h.record()).ok, false);
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.applied.length, 0);
  assert.equal(h.state.recovery.q1.text, 'new segment');
});


test('transcription account invalidation releases an unresponsive transport without waiting for output', async () => {
  let current = true;
  const h = setup({ getProviderAuth: () => ({
    captureIdentity: () => () => current,
    ensure: async () => ({ ok: true, isCurrent: () => current }),
  }), transcribe: () => new Promise(() => {}) });
  const pending = h.record(); await tick(); current = false;
  assert.equal((await pending).error.code, 'STALE_CONTEXT');
  assert.equal(h.flow.active, null);
  assert.equal(h.state.requests.length, 1);
});


test('session invalidation between transcription and rewrite retains text without sending rewrite', async () => {
  let lease = true, probes = 0;
  const h = setup({ getProviderAuth: () => ({
    captureIdentity: () => () => true,
    ensure: async () => {
      if (++probes === 2) lease = false;
      return { ok: true, isCurrent: probes === 1 ? () => lease : () => true };
    },
  }) });
  assert.equal((await h.record()).ok, false);
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.recovery.q1.text, 'new segment');
  assert.equal(h.state.applied.length, 0);
  // A later explicit click may authorize that locally retained source anew.
  assert.equal((await h.flow.run('q1', { retry: h.state.recovery.q1 })).ok, true);
  assert.equal(h.state.requests.filter(r => r.kind === 'transcribe').length, 1);
});
