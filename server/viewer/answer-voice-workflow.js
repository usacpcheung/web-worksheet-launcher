import { runProviderRequest } from '../app/bridge/provider-request.js';
import { createAnswerRecording } from './answer-recording.js';

export const REWRITE_INPUT_LIMIT = 2000;
export const AUDIO_UPLOAD_LIMIT = 20 * 1024 * 1024;
export const unicodeLength = (value) => Array.from(String(value ?? '')).length;
export const hasRecoveryText = record => record?.phase === 'text'
  || Boolean(record?.text) || record?.candidate !== undefined;
export const getVoiceRecovery = (records, id) => records && Object.hasOwn(records, id) ? records[id] : undefined;
export const hasPendingRecovery = record => Boolean(record && record.phase !== 'preflight');
export const isVoiceQuestion = (block) => block?.kind === 'question'
  && (block.responseConfig?.inputType || 'text') === 'text';

export function insertionIndex(text, intent) {
  const index = intent?.index;
  if (!intent?.deliberate || intent.snapshot !== text || !Number.isInteger(index)
    || index < 0 || index > text.length) return text.length;
  // Never split a surrogate pair, including restored or programmatic selections.
  return index > 0 && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index] || '')
    ? index + 1 : index;
}

export function insertVoiceSegment(answer, segment, index) {
  const prefix = answer.slice(0, index), suffix = answer.slice(index);
  const gap = (left, right) => /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}]\p{M}*[.!?,;:…'"”’)\]]*$/u.test(left)
    && /^["“‘'(\[]*[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}]/u.test(right) ? ' ' : '';
  const inserted = gap(prefix, segment) + segment + gap(segment, suffix);
  return { text: prefix + inserted + suffix, caret: prefix.length + inserted.length };
}

// Local-only whitelist. Audio, candidates, controllers and upstream diagnostics
// are deliberately excluded. Reload resumes at transcript editing/rewrite.
export function normalizeVoiceRecovery(records, blocks = []) {
  const entries = [];
  for (const block of blocks.filter(isVoiceQuestion)) {
    const item = records && Object.hasOwn(records, block.blockId) ? records[block.blockId] : null;
    if (!item || typeof item.text !== 'string' || !hasRecoveryText(item)) continue;
    entries.push([block.blockId, {
      phase: 'text', text: item.text, snapshot: typeof item.snapshot === 'string' ? item.snapshot : '',
      index: insertionIndex(typeof item.snapshot === 'string' ? item.snapshot : '',
        { deliberate: true, snapshot: item.snapshot, index: item.index }),
      mode: item.mode === 'rewrite' ? 'rewrite' : 'voice',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      ...(typeof item.undoSnapshot === 'string' ? { undoSnapshot: item.undoSnapshot } : {}),
    }]);
  }
  return Object.fromEntries(entries);
}

function errorCode(error, stage) {
  const code = error?.code || error?.name;
  if (error?.requiresSignIn || [401, 403].includes(error?.status)) return 'AUTH_REQUIRED';
  if (error?.status === 413) return 'UPLOAD_TOO_LARGE';
  if (error?.status === 429) return 'RATE_LIMITED';
  if (error?.status === 409) return 'BUSY';
  const known = ['AUTH_REQUIRED', 'PERMISSION_DENIED', 'DEVICE_UNAVAILABLE', 'RECORDING_UNSUPPORTED',
    'RECORDER_ERROR', 'EMPTY_RECORDING', 'RECORDING_TOO_LONG', 'UPLOAD_TOO_LARGE', 'RATE_LIMITED', 'BUSY',
    'TRANSCRIPT_TOO_LONG', 'ANSWER_TOO_LONG', 'STALE_CONTEXT', 'ABORTED', 'CANCELED'];
  return known.includes(code) ? code : stage === 'rewriting' ? 'REWRITE_FAILED'
    : stage === 'checking_session' ? 'SESSION_FAILED' : 'TRANSCRIPTION_FAILED';
}

// Race local waiting against cancellation even when a permission/session mock or
// transport does not honor AbortSignal. Late work still has a rejection handler.
function waitFor(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject({ code: 'CANCELED' });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createVoiceWorkflow({ context, apply, recover, changed = () => {},
  api, checkSession, getProviderAuth, recording = createAnswerRecording, setTimer = setInterval, clearTimer = clearInterval }) {
  let sequence = 0, active = null, timer = null;
  let pendingAudio = null;
  let lastDiagnostic = null;
  const read = (blockId) => context(blockId);
  const valid = (op) => {
    const current = read(op.blockId);
    return current.attemptId === op.attemptId && current.contextKey === op.contextKey
      && current.editable && isVoiceQuestion(current.block);
  };
  const fresh = (op) => active === op && valid(op) && read(op.blockId).answer === op.snapshot;
  const emit = () => changed();
  const stage = (op, state) => { if (active === op) { op.state = state; emit(); } };
  const finish = (op) => {
    if (active !== op) return;
    clearTimer(timer); timer = null;
    op.recorder?.teardown(); op.recorder = null;
    op.controller.abort(); active = null; emit();
  };
  const keep = (op, code, candidate) => {
    if (!valid(op)) return;
    return recover(op.blockId, { mode: op.mode, phase: op.phase, text: op.text || '', snapshot: op.snapshot,
      index: op.index, createdAt: op.createdAt, code,
      ...(typeof op.undoSnapshot === 'string' ? { undoSnapshot: op.undoSnapshot } : {}), ...(op.providerError ? { providerError: op.providerError } : {}),
      ...(candidate !== undefined ? { candidate, accountCurrent: op.accountCurrent } : {}) });
  };
  const applyCandidate = (op, candidate) => {
    if (op.accountCurrent && !op.accountCurrent()) { keep(op, 'STALE_CONTEXT'); return false; }
    if (!fresh(op)) { keep(op, 'STALE_CONTEXT', candidate); return false; }
    const value = op.mode === 'rewrite' ? { text: candidate, caret: candidate.length }
      : insertVoiceSegment(op.snapshot, candidate, op.index);
    // Match the viewer's UTF-16 maxLength/save semantics, independently of the
    // bridge's Unicode-code-point input limit. Never let autosave truncate voice.
    if (value.text.length > (read(op.blockId).block.responseConfig?.maxLength || 200)) {
      keep(op, 'ANSWER_TOO_LONG', candidate); return false;
    }
    apply(op.blockId, value.text, op.undoSnapshot ?? op.snapshot, value.caret);
    recover(op.blockId, null);
    return true;
  };
  // Both paid requests share readiness, cancellation and safe failure handling.
  // Recording preparation remains app-owned and never replays a provider call.
  async function provider(op, operation, request) {
    const auth = getProviderAuth?.();
    const result = await runProviderRequest({
      auth: { ensure: options => auth?.ensure
        ? auth.ensure({ ...options, recoverAuth: false })
        : Promise.resolve({ ok: false, error: { code: 'SESSION_PROBE_FAILED' } }) },
      signal: op.controller.signal,
      isCurrent: () => fresh(op) && (!op.identityCurrent || op.identityCurrent())
        && (!op.transcriptionCurrent || op.transcriptionCurrent()),
      request,
    });
    if (!result.ok) {
      if (result.kind === 'authentication_required' && fresh(op)) auth?.observe?.(result);
      if (!['retry_required', 'superseded', 'cancelled'].includes(result.kind)) op.providerError = {
        error: result.error, source: result.source || 'bridge', operation,
      };
    }
    return result;
  }
  async function run(blockId, { mode = 'voice', intent, retry, candidate, append = false, skipSession = false, sourceText, undoSnapshot } = {}) {
    const current = read(blockId);
    if (active || !current.editable || !current.attemptId || !isVoiceQuestion(current.block)) return { ok: false, status: 'busy_or_invalid' };
    if (!retry && hasPendingRecovery(current.recovery)) return { ok: false, status: 'recovery_pending' };
    if (hasRecoveryText(retry) && !retry.text.trim() && candidate === undefined) return { ok: false, status: 'empty_source' };
    const op = { id: ++sequence, attemptId: current.attemptId, contextKey: current.contextKey, blockId, mode,
      snapshot: retry?.snapshot ?? current.answer,
      index: insertionIndex(retry?.snapshot ?? current.answer, retry
        ? { deliberate: true, snapshot: retry.snapshot, index: retry.index } : intent),
      createdAt: new Date().toISOString(), controller: new AbortController(), state: 'checking_session',
      phase: hasRecoveryText(retry) ? 'text' : retry?.phase || 'preflight', text: retry?.text || '', undoSnapshot: undoSnapshot ?? retry?.undoSnapshot };
    if (append) { op.snapshot = current.answer; op.index = current.answer.length; op.undoSnapshot = current.answer; }
    if (mode === 'rewrite' || retry?.text || candidate !== undefined) pendingAudio = null;
    lastDiagnostic = null;
    active = op; emit();
    try {
      if (candidate !== undefined) { op.accountCurrent = retry?.accountCurrent; return { ok: applyCandidate(op, candidate) }; }
      if (!fresh(op)) { keep(op, 'STALE_CONTEXT'); return { ok: false }; }
      if (!skipSession && mode !== 'rewrite' && !hasRecoveryText(retry)) {
        const session = await waitFor(checkSession(), op.controller.signal);
        if (!session?.ok && session?.result?.skipped) return { ok: false, status: 'superseded' };
        if (!session?.ok) throw session?.result?.error || session?.error || { code: 'AUTH_REQUIRED' };
      }
      if (!fresh(op)) { keep(op, 'STALE_CONTEXT'); return { ok: false }; }
      op.identityCurrent = getProviderAuth?.()?.captureIdentity?.();
      if (mode === 'rewrite') {
        op.text = hasRecoveryText(retry) ? retry.text : sourceText ?? current.answer.trim();
        op.phase = 'text';
      } else if (!hasRecoveryText(retry)) {
        op.phase = 'capture';
        let blob;
        if (pendingAudio && pendingAudio.attemptId === op.attemptId && pendingAudio.contextKey === op.contextKey && pendingAudio.blockId === blockId
          && pendingAudio.snapshot === op.snapshot) {
          if (pendingAudio.identityCurrent && !pendingAudio.identityCurrent()) {
            pendingAudio = null;
            keep(op, 'STALE_CONTEXT');
            return { ok: false, status: 'superseded' };
          }
          op.identityCurrent = pendingAudio.identityCurrent || op.identityCurrent;
          blob = pendingAudio.blob; pendingAudio = null;
        } else {
          pendingAudio = null;
          stage(op, 'requesting_permission');
          op.recorder = recording();
          const started = await waitFor(op.recorder.start(), op.controller.signal);
          if (!started.ok) throw started.error;
          stage(op, 'recording');
          timer = setTimer(emit, 250);
          const recorded = await waitFor(op.recorder.result, op.controller.signal);
          clearTimer(timer); timer = null;
          if (!recorded.ok) throw recorded.error;
          blob = recorded.data.audioBlob;
          op.recorder = null;
        }
        if (blob.size > AUDIO_UPLOAD_LIMIT) throw { code: 'UPLOAD_TOO_LARGE' };
        stage(op, 'transcribing');
        const result = await provider(op, 'transcription', ({ signal }) => api.transcribeAudio(blob, { signal }));
        if (!result.ok) {
          if (result.kind === 'authentication_required' && fresh(op)) {
            pendingAudio = { blob, attemptId: op.attemptId, contextKey: op.contextKey, blockId, snapshot: op.snapshot, identityCurrent: op.identityCurrent };
          }
          throw { ...result.error, providerKind: result.kind };
        }
        blob = null;
        if (!result.isCurrent()) throw { code: 'STALE_CONTEXT' };
        if (typeof result.data?.text !== 'string' || !result.data.text.trim()) throw { code: 'EMPTY_RECORDING' };
        op.transcriptionCurrent = result.accountCurrent;
        op.text = result.data.text;
        op.phase = 'text';
        // Navigation may leave completed capture processing in the background.
        op.transcriptionCompleted = true;
        if (active !== op || !valid(op)) return { ok: false };
        await waitFor(keep(op, null), op.controller.signal);
      }
      if (!op.text.trim()) throw { code: 'EMPTY_RECORDING' };
      if (unicodeLength(op.text) > REWRITE_INPUT_LIMIT) throw { code: 'TRANSCRIPT_TOO_LONG' };
      if (!fresh(op)) { keep(op, 'STALE_CONTEXT'); return { ok: false }; }
      stage(op, 'checking_session');
      const result = await provider(op, 'rewrite', ({ signal }) => {
        op.phase = 'text'; stage(op, 'rewriting');
        if (!fresh(op) || signal.aborted) return { ok: false, skipped: true, status: 'superseded' };
        return api.rewriteText(op.text, { signal });
      });
      if (!result.ok) {
        if (result.kind === 'superseded') {
          if (op.state === 'checking_session' && !hasRecoveryText(retry)) return { ok: false, status: 'superseded' };
          keep(op, 'STALE_CONTEXT'); return { ok: false, status: 'recovery_required' };
        }
        throw { ...result.error, providerKind: result.kind };
      }
      // Keep only the account part for recoverable candidates; the runner's
      // predicate also owns this operation, which ends in finally below.
      op.accountCurrent = result.accountCurrent;
      if (!result.isCurrent()) { keep(op, 'STALE_CONTEXT'); return { ok: false, status: 'recovery_required' }; }
      if (active !== op) return { ok: false };
      if (!result.data?.text?.trim()) throw { code: 'REWRITE_FAILED' };
      const ok = applyCandidate(op, result.data.text.trim());
      return { ok, status: ok ? 'rewrite_applied' : 'recovery_required' };
    } catch (error) {
      if (active !== op) return { ok: false, status: 'cancelled' };
      const code = error?.providerKind ? ({ authentication_required: 'AUTH_REQUIRED', permission_denied: 'FORBIDDEN',
        cancelled: 'CANCELED', superseded: 'STALE_CONTEXT', retry_required: 'EXPLICIT_RETRY_REQUIRED',
        too_large: 'UPLOAD_TOO_LARGE', rate_limited: 'RATE_LIMITED', busy: 'BUSY' }[error.providerKind]
        || (op.state === 'transcribing' ? 'TRANSCRIPTION_FAILED' : 'REWRITE_FAILED')) : errorCode(error, op.state);
      // Memory-only troubleshooting metadata. Never retain message/details/body,
      // which can contain learner text or an upstream login page.
      lastDiagnostic = { stage: op.state, code,
        upstreamCode: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : null,
        status: Number.isInteger(error?.status) ? error.status : null,
        requestId: /^[A-Za-z0-9_-]{1,120}$/.test(error?.requestId || '') ? error.requestId : null };
      keep(op, code);
      return { ok: false, status: 'rewrite_failed', error: { code } };
    } finally { finish(op); }
  }
  return { run, get active() { return active; },
    get lastDiagnostic() { return lastDiagnostic; },
    get elapsedSeconds() { return active?.recorder?.elapsedSeconds || 0; },
    stop() { if (active?.state === 'recording') { stage(active, 'stopping'); active.recorder.stop(); } },
    navigate() {
      if (active?.state === 'recording') this.stop();
      else if (active?.state === 'requesting_permission'
        || (active?.state === 'checking_session' && !active.transcriptionCompleted)) this.cancel();
    },
    cancel({ discard = false } = {}) {
      pendingAudio = null;
      if (!active) return;
      const op = active;
      if (discard) recover(op.blockId, null);
      else keep(op, 'CANCELED');
      finish(op);
    },
    discard(blockId) { pendingAudio = null; recover(blockId, null); },
    teardown() { this.cancel(); pendingAudio = null; lastDiagnostic = null; },
  };
}
