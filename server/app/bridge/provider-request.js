import { classifySessionFailure } from '../auth/session-outcome.js';

const codes = {
  authentication_required: 'AUTH_REQUIRED', permission_denied: 'FORBIDDEN',
  cancelled: 'ABORTED', superseded: 'SUPERSEDED', timeout: 'REQUEST_TIMEOUT',
  network_error: 'NETWORK_ERROR', invalid_response: 'INVALID_JSON_RESPONSE',
  rate_limited: 'RATE_LIMITED', too_large: 'UPLOAD_TOO_LARGE',
  busy: 'BUSY', failed: 'API_ERROR', retry_required: 'EXPLICIT_RETRY_REQUIRED',
};
const failure = (kind, status) => ({ ok: false, kind, error: {
  code: codes[kind], ...(status ? { status } : {}),
  requiresSignIn: kind === 'authentication_required',
} });

// Only stable categories leave this boundary. In particular, never copy raw
// provider messages, HTML previews, exception text or request content.
export function normalizeProviderResult(result) {
  if (result?.ok === true) return { ...result, kind: 'success' };
  const error = result?.error || {};
  const rawStatus = error.status ?? result?.status;
  const status = Number.isInteger(Number(rawStatus)) && Number(rawStatus) >= 100
    && Number(rawStatus) <= 599 ? Number(rawStatus) : undefined;
  const session = classifySessionFailure(result);
  if (['authentication_required', 'permission_denied', 'cancelled', 'superseded'].includes(session)) {
    return failure(session, status);
  }
  if (status === 413) return failure('too_large', status);
  if (status === 429) return failure('rate_limited', status);
  if (status === 409) return failure('busy', status);
  // Server rejection takes precedence over misleading timeout/transport codes.
  if (status >= 400) return failure('failed', status);
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
  if (['REQUEST_TIMEOUT', 'AUDIO_TIMEOUT', 'SESSION_PROBE_TIMEOUT'].includes(code)) return failure('timeout', status);
  if (['NETWORK_ERROR', 'SESSION_PROBE_FAILED', 'SESSION_PROBE_ERROR'].includes(code)) return failure('network_error', status);
  if (['INVALID_JSON_RESPONSE', 'UNEXPECTED_NON_JSON_RESPONSE', 'UNEXPECTED_CONTENT_TYPE', 'BRIDGE_EMPTY_RESPONSE'].includes(code)) {
    return failure('invalid_response', status);
  }
  return failure('failed', status);
}

// Opt-in foundation. Existing app adapters keep their current behavior until
// migrated. One invocation authorizes at most one provider request, never replay.
// auth is the existing createReadAuthFlow interface (ensure + captureContext).
// request must return data, not mutate app state; consumers check isCurrent again
// before applying output, including after any subsequent asynchronous work.
export async function runProviderRequest({ auth, request, intent, signal,
  isCurrent = () => true, timeoutMs = null,
}) {
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)) {
    throw new TypeError('timeoutMs must be null or a positive timer duration');
  }
  const controller = new AbortController();
  let stopped = null;
  let accountCurrent = () => true;
  let finished = false;
  let timer;
  let monitor;
  let resolveStop;
  const interruption = new Promise(resolve => { resolveStop = resolve; });
  const stop = kind => {
    if (stopped || finished) return;
    stopped = failure(kind);
    // Resolve before aborting: transport abort rejections cannot hide the reason.
    resolveStop(stopped);
    controller.abort();
  };
  const current = () => !stopped && !signal?.aborted && isCurrent() && accountCurrent();
  const check = () => {
    if (signal?.aborted) stop('cancelled');
    else if (!isCurrent() || !accountCurrent()) stop('superseded');
    return !stopped;
  };
  const onAbort = () => stop('cancelled');
  // Laziness matters: a canceled owner must never start a probe or paid request.
  const wait = async task => {
    if (!check()) return stopped;
    const work = Promise.resolve().then(() => {
      if (!check()) return stopped;
      return task();
    }).catch(error => failure(error?.name === 'AbortError' ? 'cancelled' : 'network_error'));
    const result = await Promise.race([work, interruption]);
    return check() ? result : stopped;
  };
  const finish = result => ({ ...result, isCurrent: result.ok ? current : () => false });
  try {
    if (!check()) return finish(stopped);
    signal?.addEventListener('abort', onAbort, { once: true });
    monitor = setInterval(check, 50);
    // No default deadline. The adapter must explicitly choose its policy.
    // This bound covers the entire invocation, including auth and body parsing.
    if (timeoutMs !== null) timer = setTimeout(() => stop('timeout'), timeoutMs);
    const ready = await wait(() => auth.ensure({ intent, signal: controller.signal, isCurrent: current }));
    if (stopped) return finish(stopped);
    if (!ready?.ok) return finish(normalizeProviderResult(ready));
    accountCurrent = auth.captureContext();
    if (!check()) return finish(stopped);
    // A successful login prepares the UI for a new user click. Do not execute
    // the request callback, capture a microphone or persist a replay intent here.
    if (ready.authenticationRecovered) return finish(failure('retry_required'));
    const result = await wait(() => request({ signal: controller.signal, isCurrent: current }));
    if (stopped) return finish(stopped);
    return finish(normalizeProviderResult(result));
  } finally {
    finished = true;
    clearInterval(monitor);
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
