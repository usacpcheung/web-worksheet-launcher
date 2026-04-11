import { probeSession, waitForSessionReady } from './session-readiness.js';

const AUTH_POPUP_FLOW_DEFAULTS = {
  pollIntervalMs: 1000,
  pollTimeoutMs: 15000,
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
  let resolveImmediateProbe = null;

  const immediateProbePromise = new Promise((resolve) => {
    resolveImmediateProbe = resolve;
  });

  const cleanup = () => {
    if (removeMessageListener) {
      removeMessageListener();
      removeMessageListener = null;
    }
    authPopupWindow = null;
  };

  const done = (result) => {
    if (completed) return result;
    completed = true;
    cleanup();
    return result;
  };

  const cancel = () => {
    cancelled = true;
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
    resolveImmediateProbe({
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

  const pollingPromise = waitForSessionReady({
    apiClient,
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
    shouldContinue: sharedShouldContinue,
  });

  const flowPromise = Promise.race([immediateProbePromise, pollingPromise])
    .then((result) => {
      const finalResult = done(result);
      if (finalResult.ok && finalResult.status === 'ready') {
        onSessionReady(finalResult);
      } else {
        onSessionNotReady(finalResult);
      }
      return finalResult;
    })
    .catch((error) => {
      const finalResult = done({
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
      });
      onSessionNotReady(finalResult);
      return finalResult;
    });

  return {
    popupWindow: authPopupWindow,
    cancel,
    promise: flowPromise,
  };
}

export { AUTH_POPUP_FLOW_DEFAULTS, startAuthPopupFlow };
