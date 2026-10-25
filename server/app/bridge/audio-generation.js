import { runProviderRequest } from './provider-request.js';

// Product adapters own targets, confirmation and attachment. This boundary owns
// one authorized request, never login replay. Bounds reset between preparation
// and provider work. Adapters explicitly select their product deadline policy.
export const AUDIO_GENERATION_PHASE_TIMEOUT_MS = 120000;
export async function runAudioGeneration({ auth, api, text, voice = {}, isCurrent,
  signal, phaseTimeoutMs = null, beforeRequest }) {
  const controller = new AbortController();
  let timer, timedOut = false;
  const cancel = () => controller.abort();
  const startPhase = () => {
    clearTimeout(timer);
    if (phaseTimeoutMs !== null) timer = setTimeout(() => {
      timedOut = true; controller.abort();
    }, phaseTimeoutMs);
  };
  if (phaseTimeoutMs !== null && (!Number.isFinite(phaseTimeoutMs) || phaseTimeoutMs <= 0 || phaseTimeoutMs > 2147483647)) {
    throw new TypeError('Invalid audio phase timeout');
  }
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await runProviderRequest({
      signal: controller.signal, isCurrent,
      auth: { ensure: options => {
        startPhase();
        return auth?.ensure ? auth.ensure({ ...options, recoverAuth: false })
          : { ok: false, error: { code: 'SESSION_PROBE_FAILED' } };
      } },
      request: ({ signal, isCurrent: current }) => {
        clearTimeout(timer);
        const preparation = beforeRequest?.();
        if (preparation?.ok === false) return preparation;
        if (!current()) return { ok: false, skipped: true, status: 'superseded' };
        startPhase();
        return api.generateAudioFromText(text, voice, { signal });
      },
    });
    if (timedOut && result.kind === 'cancelled') return { ok: false, kind: 'timeout', error: { code: 'REQUEST_TIMEOUT' } };
    if (result.kind === 'authentication_required' && isCurrent()) auth?.observe?.(result);
    return result.ok ? { ...result, isCurrent: () => !signal?.aborted && result.isCurrent() } : result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}


// Stop local attachment waiting promptly. The task must retain its ownership
// guard after every asynchronous write and remove any newly stored stale asset.
export async function waitForAudioAttachment(task, signal) {
  const cancelled = () => ({ ok: false, reason: 'generation-failed', error: { code: 'ABORTED' } });
  if (signal?.aborted) return cancelled();
  let onAbort;
  const stopped = new Promise(resolve => { onAbort = () => resolve(cancelled()); });
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(() => signal?.aborted ? cancelled() : task()), stopped]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
