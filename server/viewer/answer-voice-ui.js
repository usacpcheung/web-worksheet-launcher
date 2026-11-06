import { getApiErrorMessage } from '../app/api/error-presentation.js';
import { supportsAnswerRecording } from './answer-recording.js';
import { REWRITE_INPUT_LIMIT, unicodeLength, hasRecoveryText, hasPendingRecovery, getVoiceRecovery, isInitialAuthRecovery, voiceInsertionRange } from './answer-voice-workflow.js';

function button(label, action) {
  const node = document.createElement('button');
  node.type = 'button'; node.className = 'icon-nav-btn'; node.textContent = label;
  node.addEventListener('click', action);
  return node;
}

export function createVoiceStatus({ session, t, view }) {
  const root = document.createElement('div'); root.className = 'viewer-voice-status';
  const label = document.createElement('span'); label.setAttribute('role', 'status');
  label.setAttribute('aria-live', 'polite');
  const timer = document.createElement('span'); timer.className = 'viewer-voice-timer';
  // Elapsed time is readable, but not announced four times per second.
  timer.setAttribute('aria-live', 'off');
  const go = button(t('viewer.voice.view'), () => view(session.voice.active?.blockId));
  const stop = button(t('viewer.voice.stop'), () => session.voice.stop());
  const cancel = button(t('viewer.voice.cancel'), () => session.voice.cancel());
  root.append(label, timer, go, stop, cancel);
  return { root, update(blockId) {
    const op = session.voice.active;
    root.hidden = !op;
    if (!op) return;
    const own = op.blockId === blockId;
    const questions = session.state.viewerPayload.blocks.filter(block => block.kind === 'question');
    const number = questions.findIndex(block => block.blockId === op.blockId) + 1;
    const stage = t(`viewer.voice.stages.${op.state}`);
    const text = own ? stage : t('viewer.voice.otherQuestion', { stage, number });
    if (label.textContent !== text) label.textContent = text;
    root.classList.toggle('is-recording', op.state === 'recording');
    timer.hidden = op.state !== 'recording';
    const seconds = Math.min(60, Math.floor(session.voice.elapsedSeconds));
    timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} / 1:00`;
    go.hidden = own; stop.hidden = op.state !== 'recording';
  } };
}

export function createVoiceControls({ session, block, control, t, view, applied, signal, sharedStatusId, canRestoreFocus, requestSignIn }) {
  let intent = null;
  let authNotice = null;
  let placedSelection = null;
  const root = document.createElement('div'); root.className = 'viewer-voice';
  const status = sharedStatusId ? null : createVoiceStatus({ session, t, view });
  if (status) status.root.id = `${control.id}-voice-status`;
  const capture = (event) => {
    if (event.type === 'select' && placedSelection?.text === control.value
      && placedSelection.index === control.selectionStart && placedSelection.index === control.selectionEnd) return;
    placedSelection = null;
    if (!control.readOnly && document.activeElement === control) {
      intent = { deliberate: true, snapshot: control.value, index: control.selectionEnd, replaceStart: control.selectionStart };
      authNotice = null;
      update();
    }
  };
  for (const event of ['pointerup', 'keyup', 'input', 'select']) control.addEventListener(event, capture);
  control.addEventListener('blur', event => {
    if (event.relatedTarget !== add) { intent = null; update(); }
  });
  const signInForRecovery = async (confirm = true) => {
    const attemptId = session.state.localAttemptId, payload = session.state.viewerPayload;
    const record = getVoiceRecovery(session.state.voiceRecovery, block.blockId);
    const isCurrent = () => !signal?.aborted && control.isConnected
      && session.state.localAttemptId === attemptId && session.state.viewerPayload === payload;
    const result = requestSignIn ? await requestSignIn({ isCurrent, confirm }) : await session.beginServerSignIn();
    if (!isCurrent()) return;
    if (result?.ok && isInitialAuthRecovery(record) && !getVoiceRecovery(session.state.voiceRecovery, block.blockId)) {
      authNotice = t(record.mode === 'rewrite' ? 'viewer.voice.signedInThenRewrite' : 'viewer.voice.signedInThenVoice');
    }
    update();
  };
  const perform = async (options = {}) => {
    if (session.voice.active) return;
    authNotice = null;
    const attemptId = session.state.localAttemptId, payload = session.state.viewerPayload;
    const result = await session.voice.run(block.blockId, { intent, ...options });
    intent = null;
    if (result?.error?.code === 'AUTH_REQUIRED' && !signal?.aborted) {
      if (requestSignIn && (!control.isConnected || session.state.localAttemptId !== attemptId
        || session.state.viewerPayload !== payload)) return;
      await signInForRecovery();
    }
    if (!signal?.aborted) update();
  };
  const add = button(t('viewer.voice.add'), () => perform());
  add.classList.add('question-card__voice-btn');
  const hint = document.createElement('p'); hint.className = 'viewer-voice-hint';
  hint.id = `${control.id}-voice-hint`;
  const recovery = document.createElement('div'); recovery.className = 'viewer-voice-recovery';
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const editorLabel = document.createElement('label'); editorLabel.textContent = t('viewer.voice.recoveryText');
  const editor = document.createElement('textarea'); editor.rows = 3;
  editorLabel.append(editor);
  editor.addEventListener('input', () => {
    const record = getVoiceRecovery(session.state.voiceRecovery, block.blockId);
    if (!record || session.voice.active) return;
    if (record.candidate !== undefined) record.candidate = editor.value;
    else record.text = editor.value;
    session.state.attemptRevision++;
    session.scheduleAutosave();
    update();
  });
  const retry = button(t('viewer.voice.retryRewrite'), () => {
    const record = getVoiceRecovery(session.state.voiceRecovery, block.blockId);
    if (record) perform({ mode: record.mode, retry: record });
  });
  const insert = button(t('viewer.voice.insert'), () => {
    const record = getVoiceRecovery(session.state.voiceRecovery, block.blockId);
    if (record) perform({ mode: record.mode, retry: record, candidate: record.candidate });
  });
  const append = button(t('viewer.voice.append'), () => {
    const record = getVoiceRecovery(session.state.voiceRecovery, block.blockId);
    if (record) perform({ mode: 'voice', retry: record, append: true,
      ...(record.candidate !== undefined ? { candidate: record.candidate } : {}) });
  });
  const signIn = button(t('viewer.voice.signIn'), () => signInForRecovery(false));
  const discard = button(t('viewer.voice.discard'), () => { session.voice.discard(block.blockId); intent = null; });
  const actions = document.createElement('div'); actions.className = 'viewer-voice-recovery-actions';
  actions.append(retry, insert, append, signIn, discard);
  recovery.append(message, editorLabel, actions);
  if (status) root.append(status.root);
  root.append(hint, recovery);
  let lastApplied = null;
  function update() {
    const completed = session.state.status === 'completed';
    const op = session.voice.active;
    const own = op?.blockId === block.blockId;
    root.hidden = completed;
    add.hidden = completed;
    const record = getVoiceRecovery(session.state.voiceRecovery, block.blockId);
    const range = voiceInsertionRange(control.value, intent);
    const replaces = range.replaceStart !== undefined;
    const retainedLength = control.value.length - (replaces ? range.index - range.replaceStart : 0);
    add.disabled = Boolean(op) || hasPendingRecovery(record) || !supportsAnswerRecording()
      || retainedLength >= (block.responseConfig?.maxLength || 200);
    add.setAttribute('aria-describedby', `${sharedStatusId || status.root.id} ${hint.id}`);
    control.readOnly = Boolean(own);
    control.classList.toggle('viewer-voice-readonly', Boolean(own));
    status?.update(block.blockId);
    hint.textContent = own ? t('viewer.voice.locked') : hasPendingRecovery(record) ? t(record.replaceStart !== undefined && record.snapshot === control.value && record.code !== 'STALE_CONTEXT' ? 'viewer.voice.resolveReplacement' : 'viewer.voice.resolveRecovery')
      : !supportsAnswerRecording() ? t('viewer.voice.errors.RECORDING_UNSUPPORTED')
      : retainedLength >= (block.responseConfig?.maxLength || 200) ? t('viewer.voice.noRoom')
        : replaces ? t('viewer.voice.replaceSelection') : intent ? t('viewer.voice.atCursor') : t('viewer.voice.atEnd');
    if (authNotice && !record && !op) hint.textContent = authNotice;
    recovery.hidden = !record || Boolean(own) || isInitialAuthRecovery(record);
    if (record) {
      message.textContent = record.providerError
        ? getApiErrorMessage(record.providerError, record.providerError.source === 'repository-api' ? 'session' : record.providerError.operation || 'rewrite', record.providerError.source)
        : t(`viewer.voice.errors.${record.code || 'RECOVERED'}`);
      if (record.phase === 'preflight' && (!record.providerError || record.code === 'AUTH_REQUIRED')) message.textContent = t(record.code === 'AUTH_REQUIRED'
        ? (record.mode === 'rewrite' ? 'viewer.voice.signInThenRewrite' : 'viewer.voice.signInThenVoice')
        : 'viewer.voice.preflightFailed');
      if (record.authenticated) message.textContent = t('viewer.voice.signedInRecovery');
      editorLabel.hidden = !hasRecoveryText(record);
      const value = record.candidate ?? record.text;
      if (document.activeElement !== editor && editor.value !== value) editor.value = value;
      editor.readOnly = Boolean(op);
      retry.hidden = record.phase === 'preflight' || record.candidate !== undefined || record.code === 'STALE_CONTEXT';
      retry.textContent = t(hasRecoveryText(record) ? 'viewer.voice.retryRewrite' : 'viewer.voice.retryRecording');
      retry.disabled = Boolean(op) || (hasRecoveryText(record) ? !record.text.trim() || unicodeLength(record.text) > REWRITE_INPUT_LIMIT : false);
      insert.hidden = record.candidate === undefined || record.code === 'STALE_CONTEXT';
      insert.disabled = Boolean(op) || !editor.value.trim();
      append.hidden = record.code !== 'STALE_CONTEXT' || !editor.value.trim();
      append.disabled = Boolean(op);
      signIn.hidden = record.code !== 'AUTH_REQUIRED';
      discard.disabled = Boolean(op);
    }
    const value = session.state.voiceApplied;
    if (value?.blockId === block.blockId && value.id !== lastApplied && !op
      && String(session.state.answers?.[block.blockId]?.value ?? '') === value.text) {
      lastApplied = value.id; intent = null;
      const visible = session.state.lastActiveBlockId === block.blockId && !document.hidden && control.isConnected
        && (!canRestoreFocus || canRestoreFocus());
      applied(value, visible);
      if (visible) {
        placedSelection = { text: value.text, index: value.caret };
        if (canRestoreFocus) control.focus({ preventScroll: true });
        else control.focus();
        control.setSelectionRange(value.caret, value.caret);
      }
      hint.textContent = t('viewer.voice.ready');
    }
  }
  return { root, add, update, rewrite: () => perform({ mode: 'rewrite' }), clearCaret: () => { intent = null; } };
}
