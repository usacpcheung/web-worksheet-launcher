import test from 'node:test';
import assert from 'node:assert/strict';

import { startAuthPopupFlow, AUTH_POPUP_FLOW_DEFAULTS } from './auth-popup-flow.js';
import { __resetSessionProbeStateForTests } from './session-readiness.js';

function createWindowStub({ popupBlocked = false } = {}) {
  let listener = null;
  const opened = [];

  globalThis.window = {
    location: {
      origin: 'https://example.test',
    },
    open: (url, name, features) => {
      opened.push({ url, name, features });
      if (popupBlocked) return null;
      return { closed: false };
    },
    addEventListener: (type, fn) => {
      if (type === 'message') listener = fn;
    },
    removeEventListener: (type, fn) => {
      if (type === 'message' && listener === fn) listener = null;
    },
    __sendMessage: async (event) => {
      if (listener) {
        await listener(event);
      }
    },
  };

  return {
    opened,
    async sendMessage(event) {
      await globalThis.window.__sendMessage(event);
    },
  };
}

test.beforeEach(() => {
  __resetSessionProbeStateForTests();
});

test('startAuthPopupFlow uses shared default poll settings', () => {
  assert.equal(AUTH_POPUP_FLOW_DEFAULTS.pollIntervalMs, 1000);
  assert.equal(AUTH_POPUP_FLOW_DEFAULTS.pollTimeoutMs, 15000);
  assert.equal(AUTH_POPUP_FLOW_DEFAULTS.hardDeadlineMs, 60000);
});

test('startAuthPopupFlow reports popup blocked and finalizes immediately', async () => {
  createWindowStub({ popupBlocked: true });

  let popupBlockedCalled = 0;
  let notReadyCalled = 0;

  const apiClient = {
    getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html?source=test',
    getSession: async () => ({ ok: false, error: { code: 'AUTH_REQUIRED', status: 401, requiresSignIn: true } }),
  };

  const flow = startAuthPopupFlow({
    apiClient,
    pollIntervalMs: 10,
    pollTimeoutMs: 30,
    onPopupBlocked: () => { popupBlockedCalled += 1; },
    onSessionNotReady: () => { notReadyCalled += 1; },
  });

  const result = await flow.promise;
  assert.equal(popupBlockedCalled, 1);
  assert.equal(notReadyCalled, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'AUTH_POPUP_BLOCKED');
  assert.equal(result.timedOut, false);
});

test('startAuthPopupFlow allows hard deadline shorter than poll timeout', async () => {
  createWindowStub();
  const apiClient = {
    getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html?source=test',
    getSession: async () => ({ ok: false, error: { code: 'AUTH_REQUIRED', status: 401, requiresSignIn: true } }),
  };

  const flow = startAuthPopupFlow({
    apiClient,
    pollIntervalMs: 10,
    pollTimeoutMs: 500,
    hardDeadlineMs: 40,
  });

  const result = await flow.promise;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'AUTH_POPUP_FLOW_HARD_DEADLINE');
  assert.equal(result.elapsedMs, 40);
});

test('startAuthPopupFlow resolves promise after async callbacks complete', async () => {
  const win = createWindowStub();
  let callbackFinished = false;

  const apiClient = {
    getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html?source=test',
    getSession: async () => ({ ok: true, data: { user: { id: 'u_async' } } }),
  };

  const flow = startAuthPopupFlow({
    apiClient,
    pollIntervalMs: 100,
    pollTimeoutMs: 500,
    onSessionReady: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      callbackFinished = true;
    },
  });

  await win.sendMessage({
    origin: 'https://example.test',
    data: { type: 'worksheet-launcher-auth-complete' },
  });

  const result = await flow.promise;
  assert.equal(result.ok, true);
  assert.equal(callbackFinished, true);
});

test('startAuthPopupFlow validates callback origin/type and resolves ready', async () => {
  const win = createWindowStub();

  let statusMessages = [];
  let sessionReadyCalled = 0;

  const apiClient = {
    getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html?source=test',
    getSession: async () => ({ ok: true, data: { user: { id: 'u_4' } } }),
  };

  const flow = startAuthPopupFlow({
    apiClient,
    pollIntervalMs: 100,
    pollTimeoutMs: 500,
    onStatusMessage: (message) => statusMessages.push(message),
    onSessionReady: () => { sessionReadyCalled += 1; },
  });

  assert.equal(win.opened.length, 1);

  await win.sendMessage({
    origin: 'https://malicious.test',
    data: { type: 'worksheet-launcher-auth-complete' },
  });

  await win.sendMessage({
    origin: 'https://example.test',
    data: { type: 'worksheet-launcher-auth-complete' },
  });

  const result = await flow.promise;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(sessionReadyCalled, 1);
  assert.equal(statusMessages.includes('Sign-in callback received. Verifying session…'), true);
});

test('startAuthPopupFlow ignores mismatched authFlowId and succeeds via fallback polling', async () => {
  const win = createWindowStub();
  let calls = 0;
  const apiClient = {
    getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html?source=test&authFlowId=flow_ok',
    getSession: async () => {
      calls += 1;
      if (calls < 2) {
        return { ok: false, error: { code: 'AUTH_REQUIRED', status: 401, requiresSignIn: true } };
      }
      return { ok: true, data: { user: { id: 'u_5' } } };
    },
  };

  const flow = startAuthPopupFlow({
    apiClient,
    authFlowId: 'flow_ok',
    pollIntervalMs: 10,
    pollTimeoutMs: 250,
  });

  await win.sendMessage({
    origin: 'https://example.test',
    data: { type: 'worksheet-launcher-auth-complete', authFlowId: 'stale_flow' },
  });

  const result = await flow.promise;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(calls >= 2, true);
});


test('startAuthPopupFlow treats poll timeout as soft when popup remains open and resolves ready on late callback', async () => {
  const win = createWindowStub();
  let shouldReturnReady = false;
  const notReadyStates = [];

  const apiClient = {
    getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html?source=test&authFlowId=late_ready',
    getSession: async () => {
      if (!shouldReturnReady) {
        return { ok: false, error: { code: 'AUTH_REQUIRED', status: 401, requiresSignIn: true } };
      }
      return { ok: true, data: { user: { id: 'u_late' } } };
    },
  };

  const flow = startAuthPopupFlow({
    apiClient,
    authFlowId: 'late_ready',
    pollIntervalMs: 10,
    pollTimeoutMs: 30,
    hardDeadlineMs: 200,
    onSessionNotReady: (state) => notReadyStates.push(state),
  });

  await new Promise((resolve) => setTimeout(resolve, 70));

  assert.equal(notReadyStates.length >= 1, true);
  assert.equal(notReadyStates.some((state) => state.waitingForCallback === true && state.final === false), true);

  shouldReturnReady = true;
  await win.sendMessage({
    origin: 'https://example.test',
    data: { type: 'worksheet-launcher-auth-complete', authFlowId: 'late_ready' },
  });

  const result = await flow.promise;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
});



test('startAuthPopupFlow finalizes timed-out error states immediately even when popup is open', async () => {
  createWindowStub();
  const notReadyStates = [];

  const apiClient = {
    getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html?source=test&authFlowId=error_timeout',
    getSession: async () => ({ ok: false, error: { code: 'BAD_GATEWAY', status: 502, message: 'Gateway error' } }),
  };

  const flow = startAuthPopupFlow({
    apiClient,
    authFlowId: 'error_timeout',
    pollIntervalMs: 10,
    pollTimeoutMs: 30,
    hardDeadlineMs: 200,
    onSessionNotReady: (state) => notReadyStates.push(state),
  });

  const result = await flow.promise;

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'BAD_GATEWAY');
  assert.equal(notReadyStates.some((state) => state.waitingForCallback === true && state.final === false), false);
  assert.equal(notReadyStates.some((state) => state.waitingForCallback === false && state.final === true), true);
});

test('startAuthPopupFlow times out when callback is missed and cleans up listener only after finalization', async () => {
  const win = createWindowStub();
  const notReadyStates = [];
  const apiClient = {
    getSessionSignInUrl: () => '/worksheet_launcher/app/login/popup.html?source=test&authFlowId=never_ready',
    getSession: async () => ({ ok: false, error: { code: 'AUTH_REQUIRED', status: 401, requiresSignIn: true } }),
  };

  const flow = startAuthPopupFlow({
    apiClient,
    authFlowId: 'never_ready',
    pollIntervalMs: 10,
    pollTimeoutMs: 30,
    hardDeadlineMs: 70,
    onSessionNotReady: (state) => { notReadyStates.push(state); },
  });

  const result = await flow.promise;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 'not_ready');
  assert.equal(notReadyStates.some((state) => state.waitingForCallback === true && state.final === false), true);
  assert.equal(notReadyStates.some((state) => state.waitingForCallback === false && state.final === true), true);

  const callCountBeforeLateMessage = notReadyStates.length;
  await win.sendMessage({
    origin: 'https://example.test',
    data: { type: 'worksheet-launcher-auth-complete', authFlowId: 'never_ready' },
  });
  assert.equal(notReadyStates.length, callCountBeforeLateMessage);
});
