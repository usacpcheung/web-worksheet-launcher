import { attachMenu } from './writing-assist/menu.js';
import { label, controls } from './writing-assist/presentation.js';
const fields = new Map();
let runtime;
let owner = null;

function success(field, message) {
  clearTimeout(field.timer);
  field.message = message;
  field.timer = setTimeout(() => {
    if (field.message === message) { field.message = ''; render(); }
  }, 3000);
}

function render() {
  const records = runtime?.records ?? {};
  const audioOwner = [...fields.values()].find(({ input }) => {
    const record = records[input.id];
    return record?.phase === 'capture' && (record.code === 'AUTH_REQUIRED' || record.authenticated);
  });
  for (const field of fields.values()) {
    const { input, buttons, recovery, recoveredText, status } = field;
    const count = input.value.length + '/' + input.maxLength;
    if (field.count.textContent !== count) field.count.textContent = count;
    const record = records[input.id];
    const own = owner?.field === field;
    const active = own ? runtime?.voice.active : null;
    const pendingElsewhere = Boolean(audioOwner && audioOwner !== field);
    const isBlocked = Boolean(owner || record || pendingElsewhere || input.disabled || input.readOnly);
    buttons.voice.disabled = isBlocked;
    const tooLong = input.value.length > 2000 && Array.from(input.value.trim()).length > 2000;
    buttons.rewrite.disabled = isBlocked || !input.value.trim() || tooLong;
    buttons.rewrite.title = tooLong ? label('limit') : '';
    buttons.undo.disabled = isBlocked || field.undo?.after !== input.value;
    buttons.stop.hidden = active?.state !== 'recording';
    buttons.cancel.hidden = !own;
    buttons.stop.disabled = !own;
    const showRecovery = Boolean(record && !own);
    recovery.hidden = !showRecovery;
    let message = field.message;
    if (active) message = runtime.t('viewer.voice.stages.' + active.state);
    else if (showRecovery) {
      const stale = input.value !== record.snapshot || record.code === 'STALE_CONTEXT';
      const hasText = record.phase === 'text' || record.candidate !== undefined;
      recoveredText.parentElement.hidden = !hasText;
      const text = record.candidate ?? record.text;
      if (hasText && recoveredText.value !== text) recoveredText.value = text;
      buttons.login.hidden = record.code !== 'AUTH_REQUIRED';
      buttons.retry.hidden = stale || !buttons.login.hidden || record.phase === 'preflight';
      buttons.retry.textContent = record.candidate !== undefined ? label('apply')
        : hasText ? label('retryRewrite') : record.authenticated ? label('retryAudio') : label('again');
      buttons.retry.disabled = Boolean(owner) || pendingElsewhere || (hasText && !text.trim());
      buttons.login.disabled = Boolean(owner) || pendingElsewhere;
      buttons.discard.disabled = Boolean(owner);
      recoveredText.readOnly = Boolean(owner);
      message = stale ? label('stale')
        : record.authenticated ? runtime.t('viewer.voice.signedInRecovery')
        : runtime.t('viewer.voice.errors.' + record.code);
      if (message.startsWith('viewer.voice.')) message = label('failed');
    } else if (!own && audioOwner && audioOwner !== field) {
      message = label('pending');
    }
    if (status.textContent !== message) status.textContent = message;
  }
}

function release(ticket) {
  if (owner !== ticket) return;
  owner = null;
  render();
}

function cancel(field) {
  if (owner?.field !== field) return;
  const ticket = owner;
  if (runtime?.voice.active) runtime.voice.cancel();
  runtime?.cancelPopup();
  field.message = label('cancelled');
  release(ticket);
}

async function run(field, action) {
  if (owner) return;
  const { input } = field;
  const id = input.id;
  const ticket = { field };
  const snapshot = input.value;
  const intent = { deliberate: field.hasCaret, snapshot, index: input.selectionEnd, replaceStart: input.selectionStart };
  const current = () => owner === ticket && document.getElementById(id) === input
    && !input.readOnly && !input.disabled && input.value === snapshot;
  owner = ticket;
  clearTimeout(field.timer);
  field.message = label('preparing');
  render();
  try {
    if (!runtime) {
      const { createLessonWorkflow } = await import('./writing-assist/workflow.js');
      if (!current()) return;
      runtime ??= createLessonWorkflow(fields, render);
    }
    if (!current()) return;
    const record = runtime.records[id];
    if (action !== 'login') {
      const options = action === 'retry'
        ? { mode: record.mode, retry: record, candidate: record.candidate }
        : { mode: action, intent };
      const result = await runtime.voice.run(id, options);
      if (owner !== ticket) return;
      if (result.ok) { success(field, action === 'voice' || record?.mode === 'voice' ? label('added') : label('rewritten')); return; }
      if (result.error?.code !== 'AUTH_REQUIRED') {
        field.message = label('stopped');
        return;
      }
    }
    if (!current()) return;
    const pending = runtime.records[id];
    field.message = label('waiting');
    render();
    const result = await runtime.signIn(id, action !== 'login', current);
    if (!current()) return;
    if (result?.ok) {
      field.message = runtime.t(pending.mode === 'rewrite' ? 'viewer.voice.signedInThenRewrite' : 'viewer.voice.signedInThenVoice');
    } else if (result?.error) {
      field.message = result.error.code === 'AUTH_POPUP_BLOCKED'
        ? label('blocked') : label('loginFailed');
      // A fresh start must remain reachable if the popup was blocked or timed out.
      runtime.voice.settleAuthentication(id, pending, false);
    } else field.message = '';
    if (document.activeElement === document.body || field.container.contains(document.activeElement)) {
      input.focus({ preventScroll: true });
    }
  } catch {
    if (owner === ticket) field.message = label('offline');
  } finally { release(ticket); }
}

let stylesheet;
export function attach(input) {
  if (!input?.matches('textarea, input:not([type]), input[type="text" i]') ||
      input.maxLength < 1 || !input.id || document.getElementById(input.id) !== input) return;
  const existing = fields.get(input.id);
  if (existing?.input === input) return existing.layout(input.dataset.writingAssist);
  if (existing) detach(existing.input);
  if (!stylesheet) {
    stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./writing-assist/controls.css', import.meta.url).href;
    document.head.append(stylesheet);
  }
  const container = document.createElement('div');
  container.className = 'wa-field';
  input.before(container);
  container.append(input);
  const panel = document.createElement('div');
  panel.className = 'wa-panel';
  panel.innerHTML = controls();
  container.append(panel);
  const listeners = new AbortController();
  const buttons = Object.fromEntries([...panel.querySelectorAll('button[data-action]')].map(button => [button.dataset.action, button]));
  const count = document.createElement('small');
  count.className = 'field-count';
  count.id = input.id + '-count';
  input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), count.id].filter(Boolean).join(' '));
  container.insertBefore(count, panel);
  const field = {
    id: input.id, panel, count, input, container, buttons, recoveredText: panel.querySelector('textarea'),
    recovery: panel.querySelector('.recovery'), status: panel.querySelector('.assist-message'),
    undo: null, message: '', hasCaret: false,
    write(value, caret) {
      input.value = value;
      input.setSelectionRange(caret, caret);
      const event = new Event('input', { bubbles: true });
      field.ownEvent = event;
      try { input.dispatchEvent(event); } finally { field.ownEvent = null; }
    },
  };
  // Lessons may give the native field a narrower width than its wrapper.
  const alignTrigger = () => {
    const box = input.getBoundingClientRect();
    const frame = container.getBoundingClientRect();
    container.style.setProperty('--wa-right-gap', Math.max(0, frame.right - box.right) + 'px');
  };
  field.resize = new ResizeObserver(alignTrigger);
  field.resize.observe(input);
  field.resize.observe(container);
  fields.set(input.id, field);
  field.listeners = listeners;
  field.layout = attachMenu(panel, input, label('tools'));
  field.layout(input.dataset.writingAssist);
  for (const type of ['select', 'pointerup', 'keyup', 'input']) {
    input.addEventListener(type, () => { if (document.activeElement === input) field.hasCaret = true; }, { signal: listeners.signal });
  }
  input.addEventListener('input', event => {
    if (event === field.ownEvent) return;
    field.undo = null;
    field.message = '';
    if (owner?.field === field) cancel(field);
    render();
  }, { signal: listeners.signal });
  field.recoveredText.addEventListener('input', () => {
    const record = runtime?.records[input.id];
    if (!record || owner) return;
    if (record.candidate !== undefined) record.candidate = field.recoveredText.value;
    else record.text = field.recoveredText.value;
    render();
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'cancel') return cancel(field);
    if (action === 'stop') return runtime.voice.stop();
    if (action === 'discard') {
      runtime.discard(input.id);
      field.message = '';
      render();
    } else if (action === 'undo') {
      if (field.undo?.after !== input.value) return;
      const { before } = field.undo;
      field.undo = null;
      field.write(before, before.length);
      success(field, label('restored'));
      input.focus();
      render();
    } else void run(field, action);
  });
  render();
}
export function detach(input) {
  const field = [...fields.values()].find(entry => entry.input === input);
  if (!field) return;
  cancel(field);
  field.listeners.abort();
  field.resize.disconnect();
  clearTimeout(field.timer);
  field.layout('toolbar');
  runtime?.discard(field.id);
  fields.delete(field.id);
  const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== field.count.id);
  if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
  else input.removeAttribute('aria-describedby');
  field.panel.remove();
  field.count.remove();
  field.container.replaceWith(...field.container.childNodes);
  render();
}
export function setLayout(input, layout) {
  if (!['compact','toolbar'].includes(layout)) return;
  input.dataset.writingAssist = layout;
  attach(input);
}

for (const input of document.querySelectorAll('[data-writing-assist]')) attach(input);
const observer = new MutationObserver(records => {
  for (const [id, field] of fields) {
    if (document.getElementById(id) !== field.input) detach(field.input);
  }
  if (records.some(record => record.type === 'attributes' && fields.get(record.target.id)?.input === record.target)) render();
});
observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['readonly', 'disabled', 'maxlength', 'id'] });
window.addEventListener('pagehide', () => {
  if (owner) cancel(owner.field);
  runtime?.clear();
  if (runtime) for (const id of fields.keys()) runtime.voice.discard(id);
  render();
});
