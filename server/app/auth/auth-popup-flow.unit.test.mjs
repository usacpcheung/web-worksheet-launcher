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
});

test('startAuthPopupFlow reports popup blocked and returns not-ready/timed-out result', async () => {
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
