const PROBE_CACHE_TTL_MS = 2000;

let latestProbeCache = null;
let inFlightProbePromise = null;

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorObject(error) {
  if (!error) return { code: 'SESSION_PROBE_FAILED', message: 'Session probe failed.' };
  if (typeof error === 'string') return { code: 'SESSION_PROBE_FAILED', message: error };
  if (typeof error === 'object') {
    return {
      code: error.code || 'SESSION_PROBE_FAILED',
      message: error.message || 'Session probe failed.',
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.requiresSignIn !== undefined ? { requiresSignIn: Boolean(error.requiresSignIn) } : {}),
    };
  }
  return { code: 'SESSION_PROBE_FAILED', message: String(error) };
}

function isSignInRequiredError(error) {
  const status = Number(error?.status);
  const code = String(error?.code || '').toUpperCase();
  return Boolean(
    error?.requiresSignIn
    || status === 401
    || status === 403
    || code === 'AUTH_REQUIRED'
  );
}

function normalizeProbeResult(sessionResult) {
  if (sessionResult?.ok === true) {
    return {
      ok: true,
      status: 'ready',
      user: sessionResult?.data?.user || sessionResult?.user || null,
      error: null,
    };
  }

  const normalizedError = toErrorObject(sessionResult?.error || sessionResult);
  return {
    ok: false,
    status: isSignInRequiredError(normalizedError) ? 'not_ready' : 'error',
    user: null,
    error: normalizedError,
  };
}

function canUseCachedProbe() {
  return Boolean(latestProbeCache && latestProbeCache.expiresAt > nowMs());
}

async function probeSession({ apiClient, force = false }) {
  if (!apiClient || typeof apiClient.getSession !== 'function') {
    throw new Error('probeSession requires apiClient.getSession().');
  }

  if (inFlightProbePromise) {
    return inFlightProbePromise;
  }

  if (!force && canUseCachedProbe()) {
    return latestProbeCache.value;
  }

  inFlightProbePromise = (async () => {
    try {
      const rawResult = await apiClient.getSession();
      const normalized = normalizeProbeResult(rawResult);
      latestProbeCache = {
        value: normalized,
        expiresAt: nowMs() + PROBE_CACHE_TTL_MS,
      };
      return normalized;
    } catch (error) {
      const normalized = normalizeProbeResult({ error });
      latestProbeCache = {
        value: normalized,
        expiresAt: nowMs() + PROBE_CACHE_TTL_MS,
      };
      return normalized;
    } finally {
      inFlightProbePromise = null;
    }
  })();

  return inFlightProbePromise;
}

async function waitForSessionReady({
  apiClient,
  intervalMs = 1000,
  timeoutMs = 15000,
  shouldContinue = null,
}) {
  const startedAt = nowMs();
  const timeoutAt = startedAt + Math.max(0, Number(timeoutMs) || 0);
  const pollIntervalMs = Math.max(50, Number(intervalMs) || 1000);

  let attempts = 0;
  let lastProbe = null;

  while (attempts === 0 || nowMs() <= timeoutAt) {
    const elapsedMs = nowMs() - startedAt;
    if (typeof shouldContinue === 'function' && shouldContinue({ elapsedMs, attempts, lastProbe }) === false) {
      return {
        ok: false,
        status: 'cancelled',
        user: null,
        error: {
          code: 'SESSION_WAIT_CANCELLED',
          message: 'Session readiness polling cancelled by caller.',
        },
        attempts,
        elapsedMs,
        timedOut: false,
        cancelled: true,
        lastProbe,
      };
    }

    attempts += 1;
    lastProbe = await probeSession({ apiClient, force: attempts > 1 });

    if (lastProbe.status === 'ready') {
      return {
        ...lastProbe,
        attempts,
        elapsedMs: nowMs() - startedAt,
        timedOut: false,
        cancelled: false,
        lastProbe,
      };
    }

    const now = nowMs();
    if (now >= timeoutAt) break;

    const remainingMs = timeoutAt - now;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  return {
    ok: false,
    status: lastProbe?.status === 'error' ? 'error' : 'not_ready',
    user: null,
    error: lastProbe?.error || {
      code: 'SESSION_NOT_READY',
      message: 'Session did not become ready before timeout.',
    },
    attempts,
    elapsedMs: nowMs() - startedAt,
    timedOut: true,
    cancelled: false,
    lastProbe,
  };
}

function __resetSessionProbeStateForTests() {
  latestProbeCache = null;
  inFlightProbePromise = null;
}

export {
  PROBE_CACHE_TTL_MS,
  probeSession,
  waitForSessionReady,
  __resetSessionProbeStateForTests,
};
