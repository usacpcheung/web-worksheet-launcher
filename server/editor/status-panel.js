import { getEditorStatusModel } from './status-model.js';

// Editor-only view. No validators, persistence, auth or mutation rules live here.
export function createStatusPanel({ t, icon, backgroundRoot, getState, getGeneration, onNavigate, onRetrySave }) {
  let destroyed = false, active = null, model = null, identity = null, contentSignature = '', retrying = false;
  const events = new AbortController();
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, text) => { const node = el('button', className, text); node.type = 'button'; return node; };
  const badge = button('editor-status-badge');
  const badgeIcon = el('span'), badgeLabel = el('span');
  const indicator = el('span', 'editor-status-indicator'); indicator.innerHTML = icon('chevronDown');
  badge.append(badgeIcon, badgeLabel, indicator);
  const infoButton = button('editor-status-info icon-btn');
  infoButton.innerHTML = icon('info'); infoButton.setAttribute('aria-label', t('editorStatus.infoTitle'));
  for (const node of [badge, infoButton]) { node.setAttribute('aria-haspopup', 'dialog'); node.setAttribute('aria-expanded', 'false'); }
  const currentIdentity = () => `${getState().draft?.localId || ''}:${getGeneration()}`;

  function close({ restoreFocus = true } = {}) {
    if (!active) return;
    const previous = active; active = null; contentSignature = '';
    previous.events.abort(); previous.overlay.remove();
    backgroundRoot.inert = previous.wasInert;
    document.body.style.overflow = previous.overflow;
    document.documentElement.style.scrollbarGutter = previous.gutter;
    previous.trigger.setAttribute('aria-expanded', 'false');
    window.scrollTo(previous.scrollX, previous.scrollY);
    if (restoreFocus && !destroyed && previous.trigger.isConnected) previous.trigger.focus({ preventScroll: true });
  }
  function renderDetails() {
    if (!active || !model) return;
    const signature = JSON.stringify([active.kind, model, retrying]);
    if (signature === contentSignature) return;
    contentSignature = signature;
    const { body, kind, closeButton } = active;
    const focused = body.contains(document.activeElement);
    const focusKey = focused ? document.activeElement.dataset.statusAction : null;
    const previousScroll = body.scrollTop;
    const issueScroll = body.querySelector('.editor-status-issues')?.scrollTop || 0;
    body.replaceChildren();
    if (kind === 'info') {
      const label = el('label', null, t('editor.labels.localDraftId'));
      const field = el('input', 'control editor-status-id'); field.readOnly = true; field.value = model.draftId || t('common.values.na');
      label.append(field);
      const copy = button('editor-status-link', t('editorStatus.copyId')); copy.dataset.statusAction = 'copy';
      const result = el('p', 'muted'); result.setAttribute('role', 'status');
      copy.onclick = async () => {
        const owner = active, id = model.draftId;
        if (!copy.isConnected || !owner || owner.identity !== currentIdentity() || destroyed) return;
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(id);
          if (active === owner && !destroyed) result.textContent = t('editorStatus.copied');
        } catch {
          if (active !== owner || destroyed) return;
          field.focus({ preventScroll: true }); field.select(); result.textContent = t('editorStatus.copyFallback');
        }
      };
      body.append(label, copy, result);
    } else {
      body.append(el('p', 'muted', t('editorStatus.savedTime', { time: model.savedTime })));
      if (model.error) {
        body.append(el('p', 'editor-status-error', model.error));
        const retry = button('editor-status-link', t('editorStatus.retrySave')); retry.dataset.statusAction = 'retry'; retry.disabled = retrying;
        retry.onclick = async () => {
          const owner = active;
          if (!retry.isConnected || retrying || destroyed || !owner || owner.identity !== currentIdentity()) return;
          retrying = true; renderDetails();
          try { await onRetrySave(); } catch { /* The existing save operation owns its error state/notification. */ }
          finally { retrying = false; if (!destroyed && identity === currentIdentity()) update(); }
        };
        body.append(retry);
      }
      if (model.warning) body.append(el('p', 'editor-status-warning', t('editorStatus.savedWarning', { warning: model.warning })));
      body.append(el('p', null, t(model.issueCount ? 'editorStatus.fixIssues' : 'editorStatus.noIssues')));
      const list = el('div', 'editor-status-issues'); list.tabIndex = 0; list.setAttribute('aria-label', t('editorStatus.issueList'));
      for (const group of model.groups) {
        const row = el('section', 'editor-status-issue');
        const messages = el('ul');
        group.messages.forEach(message => messages.append(el('li', null, message)));
        row.append(messages);
        if (group.target) {
          const go = button('editor-status-link', t(group.target.kind === 'feedback' ? 'editorStatus.goFeedback' : 'editorStatus.goBlock'));
          go.dataset.statusAction = group.key;
          go.onclick = () => {
            if (!go.isConnected || destroyed || !active || active.identity !== currentIdentity()) return;
            const fresh = getEditorStatusModel(getState(), t).groups.find(item => item.key === group.key);
            if (!fresh?.target) { update(); return; }
            const draftId = model.draftId;
            close({ restoreFocus: false }); onNavigate({ ...fresh.target, draftId });
          };
          row.append(go);
        }
        list.append(row);
      }
      if (model.groups.length) { body.append(list); list.scrollTop = issueScroll; }
    }
    body.scrollTop = previousScroll;
    if (focused) {
      const replacement = [...body.querySelectorAll('[data-status-action]')].find(node => node.dataset.statusAction === focusKey && !node.disabled);
      (replacement || closeButton).focus({ preventScroll: true });
    }
  }
  function open(kind, trigger) {
    if (destroyed || !trigger.isConnected || !model?.draftId) return;
    close({ restoreFocus: false });
    const overlay = el('div', 'confirm-modal-overlay editor-status-overlay');
    const dialog = el('section', 'confirm-modal editor-status-dialog'); dialog.dataset.kind = kind;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    const header = el('header', 'editor-status-dialog-header');
    const heading = el('h3', null, t(kind === 'info' ? 'editorStatus.infoTitle' : 'editorStatus.title'));
    heading.id = 'editor-status-dialog-title'; dialog.setAttribute('aria-labelledby', heading.id);
    const closeButton = button('editor-status-close icon-btn'); closeButton.innerHTML = icon('close'); closeButton.setAttribute('aria-label', t('common.actions.close'));
    const body = el('div', 'editor-status-dialog-body'); header.append(heading, closeButton); dialog.append(header, body); overlay.append(dialog);
    active = { kind, trigger, overlay, dialog, body, closeButton, identity: currentIdentity(), events: new AbortController(),
      wasInert: backgroundRoot.inert, overflow: document.body.style.overflow, gutter: document.documentElement.style.scrollbarGutter, scrollX: window.scrollX, scrollY: window.scrollY };
    const { signal } = active.events;
    document.documentElement.style.scrollbarGutter = 'stable'; document.body.style.overflow = 'hidden'; backgroundRoot.inert = true;
    document.body.append(overlay); trigger.setAttribute('aria-expanded', 'true'); renderDetails();
    closeButton.addEventListener('click', () => close(), { signal });
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); }, { signal });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const nodes = [...dialog.querySelectorAll('button,input,[tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    }, { signal });
    closeButton.focus({ preventScroll: true });
  }
  function update() {
    if (destroyed) return;
    const nextIdentity = currentIdentity();
    if (identity !== nextIdentity) { close({ restoreFocus: false }); identity = nextIdentity; }
    model = getEditorStatusModel(getState(), t);
    if (badgeLabel.textContent !== model.label) badgeLabel.textContent = model.label;
    if (badge.dataset.tone !== model.tone) {
      badge.dataset.tone = model.tone;
      badgeIcon.innerHTML = icon(model.tone === 'ok' ? 'check' : model.tone === 'error' ? 'close' : 'info');
    }
    badge.setAttribute('aria-label', t('editorStatus.openDetails', { status: model.label }));
    renderDetails();
  }
  badge.addEventListener('click', () => open('status', badge), { signal: events.signal });
  infoButton.addEventListener('click', () => open('info', infoButton), { signal: events.signal });
  return { badge, infoButton, update, isOpen: () => Boolean(active), destroy() { destroyed = true; events.abort(); close({ restoreFocus: false }); } };
}
