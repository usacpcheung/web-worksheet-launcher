// Coordinates state ownership, not UI or action replay. Each adapter supplies
// its existing state store and a bounded, normalized readiness probe.
export async function runOwnedSessionProbe({ readState, writeState, probe,
  presentError, isCurrent = () => true }) {
  const superseded = () => ({ ok: false, skipped: true, status: 'superseded' });
  if (!isCurrent()) return superseded();
  const previous = readState();
  let settle;
  const pending = { status: 'checking', user: null, error: null,
    expectedSubject: previous?.expectedSubject || previous?.user?.sub || null,
    settled: new Promise(resolve => { settle = resolve; }) };
  try {
    writeState(pending);
    let result;
    try { result = await probe(); }
    catch (error) {
      result = { ok: false, status: 'error', user: null,
        error: { code: 'SESSION_PROBE_FAILED', cause: error } };
    }
    if (readState() !== pending) {
      while (isCurrent() && readState()?.status === 'checking' && readState().settled) {
        await readState().settled;
      }
      const current = readState();
      const subject = result.user?.sub;
      if (isCurrent() && result.ok && result.status === 'ready' && subject
        && current?.status === 'ready' && current.user?.sub === subject
        && (!pending.expectedSubject || pending.expectedSubject === subject)) return result;
      return superseded();
    }
    if (!isCurrent()) {
      writeState(previous?.status === 'checking' || !previous
        ? { status: 'not_ready', user: null, error: null } : previous);
      return superseded();
    }
    writeState(result.ok && result.status === 'ready'
      ? { status: 'ready', user: result.user || null, error: null }
      : { status: result.status === 'error' ? 'error' : 'not_ready', user: null,
        error: presentError(result) });
    return result;
  } finally {
    settle();
  }
}
