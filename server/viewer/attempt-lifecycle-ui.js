import { t } from '../app/i18n/index.js';
import { attemptDialog } from './attempt-menu.js';
import { readLocalJson, writeLocalJson } from '../app/storage/attempt-activity.js';
const DISMISSED = 'worksheetLauncher:cleanupNoticeDismissed';
function button(label, action) {
  const node = document.createElement('button'); node.type = 'button';
  node.className = 'confirm-modal__btn'; node.textContent = label; node.onclick = action;
  return node;
}
export function mountPreviewControls({ session, header, signal, render }) {
  if (session.state.runtimeMode !== 'preview') return;
  const strip = document.createElement('div'); strip.className = 'viewer-preview-strip';
  const description = document.createElement('span'); description.textContent = t('attemptLifecycle.previewHelp');
  const badge = document.createElement('strong'); badge.textContent = t('attemptLifecycle.preview');
  const restart = button(t('attemptLifecycle.restart'), async () => {
    restart.disabled = true;
    try { if (await session.lifecycle.restartPreview()) render(); }
    catch (error) { session.pushNotification({ kind: 'error', text: error.message }); }
    finally { restart.disabled = false; }
  });
  strip.append(badge, description, restart); header.prepend(strip);
  signal.addEventListener('abort', () => strip.remove(), { once: true });
}
export function mountLocalCleanup({ session, panel }) {
  if (!session.lifecycle) return;
  const row = document.createElement('div'); row.className = 'viewer-local-cleanup';
  const notice = document.createElement('p'); notice.className = 'muted'; notice.hidden = true;
  const status = document.createElement('p'); status.className = 'muted'; status.setAttribute('role', 'status');
  const later = button(t('attemptLifecycle.later'), () => {
    writeLocalJson(DISMISSED, true); notice.hidden = true; later.hidden = true;
  }); later.hidden = true;
  const review = button(t('attemptLifecycle.cleanup'), async () => {
    review.disabled = true;
    try {
      const result = await session.lifecycle.collect({ apply: false });
      if (!panel.isConnected || !result) return;
      if (result.unavailable) { status.textContent = t('attemptLifecycle.cleanupUnavailable'); return; }
      const count = result.attempts.length;
      if (!count && !result.assets.length && !result.worksheets.length) { status.textContent = t('attemptLifecycle.nothingToClean'); return; }
      const accepted = await attemptDialog({ title: t('attemptLifecycle.cleanup'),
        description: t('attemptLifecycle.cleanupReview', { count, size: (result.bytes / 1024 / 1024).toFixed(1) }),
        confirmLabel: t('attemptLifecycle.clean'), cancelLabel: t('common.actions.cancel'), isCurrent: () => panel.isConnected });
      if (!accepted) return;
      await session.lifecycle.collect({ selection: result.selection });
      writeLocalJson(DISMISSED, true); notice.hidden = true; later.hidden = true;
      status.textContent = t('attemptLifecycle.cleaned');
    } catch (error) { status.textContent = t('attemptLifecycle.cleanupFailed'); }
    finally { review.disabled = false; }
  });
  row.append(notice, review, later, status); panel.append(row);
  if (!readLocalJson(DISMISSED, false)) void session.lifecycle.collect({ apply: false }).then(result => {
    if (!panel.isConnected || !result || result.unavailable || (!result.attempts.length && !result.worksheets.length && !result.assets.length)) return;
    notice.textContent = t('attemptLifecycle.cleanupNotice'); notice.hidden = false; later.hidden = false;
  }).catch(() => {});
}
