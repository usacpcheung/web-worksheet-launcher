import { classifySessionFailure } from '../auth/session-outcome.js';

const codes = {
  authentication_required: 'AUTH_REQUIRED', permission_denied: 'FORBIDDEN',
  cancelled: 'ABORTED', superseded: 'SUPERSEDED', timeout: 'REQUEST_TIMEOUT',
  network_error: 'NETWORK_ERROR', invalid_response: 'INVALID_JSON_RESPONSE',
  rate_limited: 'RATE_LIMITED', too_large: 'UPLOAD_TOO_LARGE',
  busy: 'BUSY', voice_unsupported: 'VOICE_CHOICE_UNSUPPORTED', failed: 'API_ERROR', retry_required: 'EXPLICIT_RETRY_REQUIRED',
};
const failure = (kind, status) => ({ ok: false, kind, error: {
  code: codes[kind], ...(status ? { status } : {}),
  requiresSignIn: kind === 'authentication_required',
} });

// Only stable categories leave this boundary. In particular, never copy raw
// provider messages, HTML previews, exception text or request content.
export function normalizeProviderResult(result, { source = 'bridge' } = {}) {
  if (result?.ok === true) return { ...result, kind: 'success' };
  const error = result?.error || {};
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
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
  if (source === 'repository-api' && !(status >= 400)) {
    const authKinds = {
      AUTH_POPUP_FLOW_HARD_DEADLINE: 'timeout', SESSION_PROBE_TIMEOUT: 'timeout',
      SESSION_TIMEOUT: 'timeout', SESSION_WAIT_TIMEOUT: 'timeout',
      AUTH_POPUP_BLOCKED: 'failed', AUTH_POPUP_FLOW_ERROR: 'failed',
      SESSION_PROBE_FAILED: 'network_error', SESSION_PROBE_ERROR: 'network_error',
    };
    if (Object.hasOwn(authKinds, code)) {
      return { ...failure(authKinds[code], status), source,
        error: { code, ...(status ? { status } : {}), requiresSignIn: false } };
    }
  }
  const providerKinds = {
    VOICE_CHOICE_UNSUPPORTED: 'voice_unsupported', RATE_LIMITED: 'rate_limited',
    RATE_LIMIT_EXCEEDED: 'rate_limited', UPLOAD_TOO_LARGE: 'too_large',
    PAYLOAD_TOO_LARGE: 'too_large', BUSY: 'busy', SERVICE_BUSY: 'busy',
  };
  if (!(status >= 500) && Object.hasOwn(providerKinds, code)) return failure(providerKinds[code], status);
  // Server rejection takes precedence over misleading timeout/transport codes.
  if (status >= 400) return failure('failed', status);
  if (['REQUEST_TIMEOUT', 'AUDIO_TIMEOUT', 'SESSION_PROBE_TIMEOUT'].includes(code)) return failure('timeout', status);
  if (['NETWORK_ERROR', 'SESSION_PROBE_FAILED', 'SESSION_PROBE_ERROR'].includes(code)) return failure('network_error', status);
  if (['INVALID_JSON_RESPONSE', 'UNEXPECTED_NON_JSON_RESPONSE', 'UNEXPECTED_CONTENT_TYPE', 'BRIDGE_EMPTY_RESPONSE'].includes(code)) {
    return failure('invalid_response', status);
  }
  return failure('failed', status);
}

// Opt-in foundation. Existing app adapters keep their current behavior until
// migrated. One invocation authorizes at most one provider request, never replay.
// auth is the existing createReadAuthFlow interface (ensure with withContext: true).
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
  const finish = result => ({ ...result, isCurrent: result.ok ? current : () => false,
    ...(result.ok ? { accountCurrent } : {}) });
  try {
    if (!check()) return finish(stopped);
    signal?.addEventListener('abort', onAbort, { once: true });
    monitor = setInterval(check, 50);
    // No default deadline. The adapter must explicitly choose its policy.
    // This bound covers the entire invocation, including auth and body parsing.
    if (timeoutMs !== null) timer = setTimeout(() => stop('timeout'), timeoutMs);
    const ready = await wait(() => auth.ensure({ intent, signal: controller.signal, isCurrent: current, withContext: true }));
    if (stopped) return finish(stopped);
    if (!ready?.ok) return finish({ ...normalizeProviderResult(ready, { source: 'repository-api' }), source: 'repository-api' });
    // Fail closed for an adapter that has not implemented verification leases.
    if (typeof ready.isCurrent !== 'function') return finish(failure('invalid_response'));
    accountCurrent = ready.isCurrent;
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
