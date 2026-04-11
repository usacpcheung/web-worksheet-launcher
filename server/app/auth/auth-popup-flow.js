import { probeSession, waitForSessionReady } from './session-readiness.js';

const AUTH_POPUP_FLOW_DEFAULTS = {
  pollIntervalMs: 1000,
  pollTimeoutMs: 15000,
  hardDeadlineMs: 60000,
  messageType: 'worksheet-launcher-auth-complete',
};

function noop() {}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeMessageData(data) {
  if (!isRecord(data)) return null;
  return data;
}


async function invokeCallbackSafely(callback, payload, label) {
  try {
    await Promise.resolve(callback?.(payload));
  } catch (error) {
    console.error(`startAuthPopupFlow ${label} callback failed`, error);
  }
}

function startAuthPopupFlow(options = {}) {
  const {
    apiClient,
    source = 'generic',
    popupName = 'worksheet_launcher_auth_popup',
    popupFeatures = 'width=520,height=720,left=160,top=120,resizable=yes,scrollbars=yes',
    expectedOrigin = window?.location?.origin || '',
    expectedMessageType = AUTH_POPUP_FLOW_DEFAULTS.messageType,
    authFlowId = null,
    pollIntervalMs = AUTH_POPUP_FLOW_DEFAULTS.pollIntervalMs,
    pollTimeoutMs = AUTH_POPUP_FLOW_DEFAULTS.pollTimeoutMs,
    hardDeadlineMs = AUTH_POPUP_FLOW_DEFAULTS.hardDeadlineMs,
    shouldContinue = null,
    onPopupBlocked = noop,
    onStatusMessage = noop,
    onSessionReady = noop,
    onSessionNotReady = noop,
  } = options;

  if (!apiClient || typeof apiClient.getSessionSignInUrl !== 'function') {
    throw new Error('startAuthPopupFlow requires apiClient.getSessionSignInUrl().');
  }
  if (typeof apiClient.getSession !== 'function') {
    throw new Error('startAuthPopupFlow requires apiClient.getSession().');
  }

  let completed = false;
  let cancelled = false;
  let authPopupWindow = null;
  let removeMessageListener = null;
  let hardDeadlineTimer = null;

  let resolveFlowPromise = null;
  const flowPromise = new Promise((resolve) => {
    resolveFlowPromise = resolve;
  });

  const cleanup = () => {
    if (removeMessageListener) {
      removeMessageListener();
      removeMessageListener = null;
    }
    if (hardDeadlineTimer) {
      clearTimeout(hardDeadlineTimer);
      hardDeadlineTimer = null;
    }
    authPopupWindow = null;
  };

  const done = (result) => {
    if (completed) return result;
    completed = true;
    cleanup();
    resolveFlowPromise?.(result);
    return result;
  };

  const finalize = async (result) => {
    if (completed) return null;
    const finalResult = done(result);
    if (finalResult.ok && finalResult.status === 'ready') {
      await invokeCallbackSafely(onSessionReady, finalResult, 'onSessionReady');
    } else {
      await invokeCallbackSafely(
        onSessionNotReady,
        { ...finalResult, waitingForCallback: false, final: true },
        'onSessionNotReady'
      );
    }
    return finalResult;
  };

  const cancel = () => {
    cancelled = true;
    void finalize({
      ok: false,
      status: 'cancelled',
      user: null,
      error: {
        code: 'AUTH_POPUP_FLOW_CANCELLED',
        message: 'Sign-in flow cancelled by caller.',
      },
      attempts: 0,
      elapsedMs: 0,
      timedOut: false,
      cancelled: true,
      lastProbe: null,
      waitingForCallback: false,
      final: true,
    });
    return true;
  };

  const signInContext = { source };
  if (authFlowId) {
    signInContext.authFlowId = authFlowId;
  }

  const popupUrl = apiClient.getSessionSignInUrl(signInContext);
  authPopupWindow = window.open(popupUrl, popupName, popupFeatures);

  if (!authPopupWindow) {
    onPopupBlocked();
    onStatusMessage('Sign-in popup was blocked.');
  } else {
    onStatusMessage('Complete sign-in in the popup. Session will refresh automatically.');
  }

  const messageListener = async (event) => {
    if (completed || cancelled) return;
    if (!event || event.origin !== expectedOrigin) return;

    const messageData = normalizeMessageData(event.data);
    if (!messageData) return;
    if (messageData.type !== expectedMessageType) return;
    if (authFlowId && messageData.authFlowId !== authFlowId) return;

    onStatusMessage('Sign-in callback received. Verifying session…');
    const probeResult = await probeSession({ apiClient, force: true });
    await finalize({
      ...probeResult,
      attempts: 1,
      elapsedMs: 0,
      timedOut: false,
      cancelled: false,
      lastProbe: probeResult,
    });
  };

  window.addEventListener('message', messageListener);
  removeMessageListener = () => {
    window.removeEventListener('message', messageListener);
  };

  const sharedShouldContinue = (context) => {
    if (cancelled || completed) return false;
    if (typeof shouldContinue === 'function') {
      return shouldContinue({ ...context, popup: authPopupWindow }) !== false;
    }
    return true;
  };

  const normalizedHardDeadlineMs = Math.max(Number(hardDeadlineMs) || 0, Number(pollTimeoutMs) || 0);
  if (normalizedHardDeadlineMs > 0) {
    hardDeadlineTimer = setTimeout(() => {
      if (completed || cancelled) return;
      onStatusMessage('Sign-in is still pending and exceeded the maximum wait window.');
      void finalize({
        ok: false,
        status: 'not_ready',
        user: null,
        error: {
          code: 'AUTH_POPUP_FLOW_HARD_DEADLINE',
          message: 'Session did not become ready before the maximum wait deadline.',
        },
        attempts: 0,
        elapsedMs: normalizedHardDeadlineMs,
        timedOut: true,
        cancelled: false,
        lastProbe: null,
        waitingForCallback: false,
        final: true,
      });
    }, normalizedHardDeadlineMs);
  }

  const pollingPromise = waitForSessionReady({
    apiClient,
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
    shouldContinue: sharedShouldContinue,
  });

  pollingPromise
    .then(async (result) => {
      if (completed || cancelled) return;

      if (result.ok && result.status === 'ready') {
        await finalize(result);
        return;
      }

      if (result.cancelled || cancelled) {
        await finalize({
          ...result,
          waitingForCallback: false,
          final: true,
        });
        return;
      }

      const popupOpen = authPopupWindow && authPopupWindow.closed !== true;
      const canWaitForCallback = Boolean(popupOpen);

      if (result.timedOut && canWaitForCallback) {
        onStatusMessage('Sign-in check timed out, still waiting for popup callback…');
        await invokeCallbackSafely(
          onSessionNotReady,
          { ...result, waitingForCallback: true, final: false },
          'onSessionNotReady'
        );
        return;
      }

      await finalize({
        ...result,
        waitingForCallback: false,
        final: true,
      });
    })
    .catch((error) => {
      if (completed || cancelled) return;
      finalize({
        ok: false,
        status: 'error',
        user: null,
        error: {
          code: 'AUTH_POPUP_FLOW_ERROR',
          message: error?.message || String(error),
        },
        attempts: 0,
        elapsedMs: 0,
        timedOut: false,
        cancelled,
        lastProbe: null,
        waitingForCallback: false,
        final: true,
      });
    });

  return {
    popupWindow: authPopupWindow,
    cancel,
    promise: flowPromise,
  };
}

export { AUTH_POPUP_FLOW_DEFAULTS, startAuthPopupFlow };