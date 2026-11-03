// Viewer-only dialogs. Auth remains owned by the existing session coordinator.
export function attemptDialog({ title, description = '', label, value = '', limit = 80, optional = false, readOnly = false, existingValue = '', confirmLabel, cancelLabel, invalidLabel, isCurrent = () => true, onInput }) {
  if (!isCurrent()) return Promise.resolve(null);
  return new Promise(resolve => {
    const previous = document.activeElement?.closest('.viewer-attempt-menu')
      ? document.querySelector('[aria-controls="viewer-attempt-menu"]') : document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-modal viewer-attempt-dialog';
    const heading = document.createElement('h3'); heading.textContent = title; heading.id = 'viewer-attempt-dialog-title';
    dialog.setAttribute('aria-labelledby', heading.id);
    const text = document.createElement('p'); text.textContent = description;
    const form = document.createElement('form');
    const actions = document.createElement('div'); actions.className = 'confirm-modal__actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = cancelLabel; cancel.className = 'confirm-modal__btn';
    const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.textContent = confirmLabel; confirm.className = 'confirm-modal__btn viewer-attempt-primary';
    let input;
    if (label) {
      const caption = document.createElement('label'); caption.textContent = label; caption.htmlFor = 'viewer-attempt-dialog-input';
      input = document.createElement('input'); input.id = caption.htmlFor; input.value = value; input.readOnly = readOnly;
      const counter = document.createElement('p'); counter.className = 'viewer-attempt-counter';
      const error = document.createElement('p'); error.className = 'input-error'; error.id = 'viewer-attempt-dialog-error'; error.setAttribute('role', 'status');
      input.setAttribute('aria-describedby', error.id);
      const validate = () => {
        const length = Array.from(input.value.trim()).length;
        const invalid = (!optional && !length) || (!readOnly && length > limit && input.value.trim() !== existingValue);
        confirm.disabled = invalid; counter.textContent = readOnly ? '' : `${Array.from(input.value).length}/${limit}`;
        error.textContent = invalid ? invalidLabel : ''; input.setAttribute('aria-invalid', String(invalid));
      };
      input.addEventListener('input', () => { onInput?.(input.value); validate(); });
      form.append(caption, input, counter, error); validate();
    }
    actions.append(cancel, confirm); form.append(actions); dialog.append(heading, text, form); document.body.append(dialog);
    let finished = false;
    const finish = result => { if (finished) return; finished = true; clearInterval(timer); dialog.close(); dialog.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); resolve(isCurrent() ? result : null); };
    const timer = setInterval(() => { if (!isCurrent()) finish(null); }, 100);
    cancel.onclick = () => finish(null);
    dialog.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    form.onsubmit = e => { e.preventDefault(); if (!confirm.disabled) finish(input ? input.value.trim() : true); };
    dialog.showModal(); (input || cancel).focus();
  });
}

export function createAttemptMenu({ trigger, items, signal }) {
  const menu = document.createElement('div'); menu.className = 'viewer-attempt-menu'; menu.hidden = true;
  menu.id = 'viewer-attempt-menu'; trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('aria-expanded', 'false');
  for (const { button, label } of items) {
    const text = document.createElement('span'); text.textContent = label;
    button.append(text); button.classList.remove('viewer-header-icon-btn'); button.classList.add('viewer-attempt-menu-item');
    menu.append(button);
  }
  document.body.append(menu);
  const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
  const position = () => {
    if (menu.hidden) return;
    const r = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(innerWidth - menu.offsetWidth - 12, r.right - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(12, Math.min(innerHeight - menu.offsetHeight - 12, r.bottom + 8))}px`;
  };
  trigger.addEventListener('click', () => {
    if (!menu.hidden) { close(); return; }
    menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    position();
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }, { signal });
  menu.addEventListener('click', e => { if (e.target.closest('button')) { close(); trigger.focus({ preventScroll: true }); } }, { capture: true, signal });
  document.addEventListener('pointerdown', e => { if (!menu.contains(e.target) && !trigger.contains(e.target)) close(); }, { signal });
  document.addEventListener('keydown', e => { if (!menu.hidden && e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); } }, { signal });
  document.addEventListener('focusin', e => { if (!menu.hidden && !menu.contains(e.target) && !trigger.contains(e.target)) close(); }, { signal });
  window.addEventListener('resize', close, { signal }); window.addEventListener('scroll', position, { passive: true, signal });
  signal.addEventListener('abort', () => menu.remove(), { once: true });
  return { close };
}

export function defaultAttemptName(title, student) {
  const suffix = student?.trim() ? ` — ${student.trim()}` : '';
  const name = Array.from(suffix).slice(0, 60).join('');
  return Array.from(String(title || '')).slice(0, 80 - Array.from(name).length).join('') + name;
}

// Legacy records have no provenance: preserve names that differ from the suggestion.
export function attemptNameMode(record, title, student) {
  if (record.attemptNameMode === 'auto' || record.attemptNameMode === 'custom') return record.attemptNameMode;
  const name = record.attemptNameDraft || record.savedAttemptName || '';
  return !name || name === defaultAttemptName(title, student) ? 'auto' : 'custom';
}

export function currentAttemptName(state) {
  return attemptNameMode(state, state.viewerPayload?.title, state.studentName) === 'custom'
    ? (state.attemptNameDraft ?? state.savedAttemptName ?? '')
    : defaultAttemptName(state.viewerPayload?.title, state.studentName);
}
