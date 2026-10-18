import { classifySessionFailure } from './session-outcome.js';

const stale = () => ({ ok: false, skipped: true, status: 'superseded' });

// Release an obsolete caller promptly without canceling a login still used by
// another subscriber. The late promise remains observed (including rejection).
function whileCurrent(promise, current) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearInterval(timer); callback(value);
    };
    const timer = setInterval(() => { if (!current()) finish(resolve, stale()); }, 50);
    Promise.resolve(promise).then(value => finish(resolve, current() ? value : stale()), error => finish(current() ? reject : resolve, current() ? error : stale()));
    if (!current()) finish(resolve, stale());
  });
}

// Read-only recovery. Callers supply the actual read, never a mutation or a
// callback that also applies content. Application of results remains caller-owned.
export function createReadAuthFlow({ probe, signIn, prompt, subject, invalidate, redirect }) {
  let recovery = null;
  let epoch = 0;
  let authFailureVersion = 0;
  let knownSubject = subject() || null;
  const observed = new WeakSet();
  const observe = result => {
    if (!result || typeof result !== 'object' || observed.has(result)) return result;
    observed.add(result);
    if (!result.ok && classifySessionFailure(result) === 'authentication_required') {
      authFailureVersion++;
      invalidate('signed_out');
    }
    const next = result?.ok && result.status === 'ready' ? result.user?.sub : null;
    if (next && knownSubject && next !== knownSubject) {
      epoch++;
      invalidate('account_changed');
    }
    if (next) knownSubject = next;
    return result;
  };
  const recover = async (current, intent) => {
    if (!recovery) {
      const subscribers = new Set();
      const entry = { subscribers, promise: null };
      recovery = entry;
      entry.promise = (async () => {
        const anyCurrent = () => [...subscribers].some(entry => entry.current());
        // Start on the next microtask, after the first subscriber is registered.
        await Promise.resolve();
        const accepted = await prompt({ isCurrent: anyCurrent });
        if (!anyCurrent()) return stale();
        if (!accepted) return { ok: false, cancelled: true, status: 'not_ready', error: { code: 'AUTH_REQUIRED', requiresSignIn: true } };
        let result = await signIn();
        while (result?.error?.code === 'AUTH_POPUP_BLOCKED' && anyCurrent()) {
          const owner = [...subscribers].find(entry => entry.current());
          const choice = await prompt({ isCurrent: anyCurrent, blocked: true, canRedirect: Boolean(redirect && owner?.intent),
            redirect: async ({ isCurrent: promptCurrent }) => {
              const selected = [...subscribers].find(entry => entry.current() && entry.intent);
              if (selected && promptCurrent()) await redirect({ intent: selected.intent,
                isCurrent: () => selected.current() && promptCurrent(), subject: knownSubject });
            } });
          if (!anyCurrent() || !choice) return stale();
          result = await signIn();
        }
        if (!anyCurrent()) return stale();
        if (!result?.ok) return result || stale();
        const verified = await probe({ isCurrent: anyCurrent });
        if (!anyCurrent()) return stale();
        if (verified.ok && !verified.user?.sub) return { ok: false, status: 'error', error: { code: 'SESSION_PROBE_FAILED' } };
        return observe(verified);
      })().finally(() => { if (recovery === entry) recovery = null; });
    }
    const entry = recovery;
    const subscriber = { current, intent };
    entry.subscribers.add(subscriber);
    try { return await whileCurrent(entry.promise, current); }
    finally { entry.subscribers.delete(subscriber); }
  };
  const ensure = async ({ isCurrent = () => true, signal, intent, timeoutMs } = {}) => {
    const startEpoch = epoch;
    const current = () => !signal?.aborted && isCurrent() && startEpoch === epoch;
    if (!current()) return stale();
    let result = await whileCurrent(probe({ isCurrent: current, timeoutMs }), current);
    if (!isCurrent() || signal?.aborted) return stale();
    result = observe(result);
    if (!current()) return stale();
    if (!result.ok && classifySessionFailure(result) === 'authentication_required') {
      result = await recover(current, intent);
    }
    return current() ? result : stale();
  };
  const read = async (request, { isCurrent = () => true, signal, preflight = true, intent } = {}) => {
    const startEpoch = epoch;
    const initialSubject = subject() || knownSubject;
    const contextCurrent = () => !signal?.aborted && isCurrent() && epoch === startEpoch;
    const current = () => contextCurrent() && (!initialSubject || !subject() || subject() === initialSubject);
    if (!current()) return stale();
    if (preflight) {
      const ready = await ensure({ isCurrent: contextCurrent, signal, intent });
      if (!ready.ok || !current()) return current() ? ready : stale();
    }
    const requestVersion = authFailureVersion;
    let result = await whileCurrent(request(), current);
    if (!current() || (result.ok && requestVersion !== authFailureVersion)) return stale();
    if (!result.ok && classifySessionFailure(result) === 'authentication_required') {
      authFailureVersion++;
      invalidate('signed_out');
      const ready = await recover(current, intent);
      if (!current()) return stale();
      if (!ready.ok) return ready;
      // At most one repeat. A second auth failure is returned to the surface.
      const retryVersion = authFailureVersion;
      result = await whileCurrent(request(), current);
      if (!current() || (result.ok && retryVersion !== authFailureVersion)) return stale();
      if (!result.ok && classifySessionFailure(result) === 'authentication_required') {
        authFailureVersion++;
        invalidate('signed_out');
      }
    }
    return result;
  };
  return { ensure, read, observe };
}
