// A browser is mounted only after consent/readiness. A stale opener cannot
// display a list over a replacement attempt or a newer browser request.
export async function prepareBrowserEntry(session, intent, { signal } = {}) {
  if (signal?.aborted || session._browserEntry) return false;
  const owner = {};
  const attemptId = session.state.localAttemptId;
  const generation = session._uploadContextGeneration;
  session._browserEntry = owner;
  const isCurrent = () => session._browserEntry === owner && !signal?.aborted
    && session.state.localAttemptId === attemptId && session._uploadContextGeneration === generation;
  try {
    const ready = await session.ensureReadSessionReady({ intent, signal, isCurrent });
    if (!ready.ok && isCurrent() && !ready.result?.cancelled && !ready.result?.skipped) {
      session.pushNotification?.({ kind: 'error', text: session.state.serverActionMessage });
    }
    return ready.ok && isCurrent() && ready.isCurrent?.() === true;
  } finally {
    if (session._browserEntry === owner) session._browserEntry = null;
  }
}
