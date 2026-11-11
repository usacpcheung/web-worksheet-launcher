import { t } from '../app/i18n/index.js';

let browserEntrySequence = 0;
const BROWSER_ENTRY_ERROR_SOURCE = 'viewer.browser-entry.error';

// A browser is mounted only after consent/readiness. A stale opener cannot
// display a list over a replacement attempt or a newer browser request.
export async function prepareBrowserEntry(session, intent, { signal } = {}) {
  if (signal?.aborted || session._browserEntry) return false;
  const source = `viewer.browser-entry.${++browserEntrySequence}`;
  const owner = {
    clearFeedback: () => session.clearNotificationsBySource?.(source),
  };
  const attemptId = session.state.localAttemptId;
  const generation = session._uploadContextGeneration;
  session._browserEntry = owner;
  const isCurrent = () => session._browserEntry === owner && !signal?.aborted
    && session.state.localAttemptId === attemptId && session._uploadContextGeneration === generation;
  const dispose = () => {
    signal?.removeEventListener('abort', dispose);
    owner.clearFeedback();
    if (session._browserEntry === owner) session._browserEntry = null;
  };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    session.clearNotificationsBySource?.(BROWSER_ENTRY_ERROR_SOURCE);
    session.setNotificationForSource?.(source, { kind: 'info', text: t('viewer.packageLoad.checking') });
    const ready = await session.ensureReadSessionReady({ intent, signal, isCurrent });
    if (!ready.ok && isCurrent() && !ready.result?.cancelled && !ready.result?.skipped) {
      session.pushNotification?.({ kind: 'error', source: BROWSER_ENTRY_ERROR_SOURCE, text: session.state.serverActionMessage });
    }
    return ready.ok && isCurrent() && ready.isCurrent?.() === true;
  } finally {
    dispose();
  }
}
