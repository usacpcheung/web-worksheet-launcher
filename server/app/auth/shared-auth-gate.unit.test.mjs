import test from 'node:test';
import assert from 'node:assert/strict';

import { SharedAuthGate } from './shared-auth-gate.js';

function createStorage() {
  let pending = null;
  const flags = {};

  return {
    pendingIntent: {
      set: (value) => {
        pending = value;
      },
      get: () => pending,
      clear: () => {
        pending = null;
      },
    },
    resumeFlags: {
      set: (key, value) => {
        flags[key] = value;
      },
      get: (key) => flags[key] || null,
    },
  };
}

function createWindowStub(href = 'https://example.test/viewer/?auth=1&authReturn=1') {
  const replaceCalls = [];
  globalThis.window = {
    location: { href },
    history: {
      replaceState: (...args) => {
        replaceCalls.push(args);
      },
    },
  };
  return { replaceCalls };
}

test('runProtectedAction persists pending intent and redirects when unauthenticated', async () => {
  const storage = createStorage();
  const redirectCalls = [];

  globalThis.window = {
    location: { href: 'https://example.test/editor/?localDraftId=draft_1' },
  };

  const gate = new SharedAuthGate({
    appArea: 'editor',
    resumeFlagKey: 'editor:lastSession',
    storage,
    isAuthenticated: () => false,
    getCurrentLocalId: () => 'draft_1',
    getCurrentUiState: () => ({ mode: 'edit' }),
    persistLocalRecord: async () => {},
    redirectToAuth: ({ redirectTo }) => redirectCalls.push(redirectTo),
  });

  const result = await gate.runProtectedAction({
    actionId: 'resumePublishAfterLogin',
    recordStore: 'localDrafts',
  });

  assert.equal(result.status, 'redirected');
  assert.equal(storage.pendingIntent.get().actionId, 'resumePublishAfterLogin');
  assert.equal(storage.resumeFlags.get('editor:lastSession').localId, 'draft_1');
  assert.equal(redirectCalls.length, 1);
  assert.equal(redirectCalls[0].includes('authReturn=1'), true);
  assert.equal(redirectCalls[0].includes('intent='), false);
});

test('runProtectedAction returns invalid_intent for missing actionId without side effects', async () => {
  const storage = createStorage();
  let persistCalled = false;
  let redirectCalled = false;

  createWindowStub('https://example.test/editor/?localDraftId=draft_1');

  const gate = new SharedAuthGate({
    appArea: 'editor',
    resumeFlagKey: 'editor:lastSession',
    storage,
    isAuthenticated: () => false,
    getCurrentLocalId: () => 'draft_1',
    getCurrentUiState: () => ({ mode: 'edit' }),
    persistLocalRecord: async () => {
      persistCalled = true;
    },
    redirectToAuth: () => {
      redirectCalled = true;
    },
  });

  const result = await gate.runProtectedAction({
    recordStore: 'localDrafts',
  });

  assert.equal(result.status, 'invalid_intent');
  assert.equal(persistCalled, false);
  assert.equal(redirectCalled, false);
  assert.equal(storage.pendingIntent.get(), null);
  assert.equal(storage.resumeFlags.get('editor:lastSession'), null);
});

test('runProtectedAction returns invalid_intent for missing recordStore without side effects', async () => {
  const storage = createStorage();
  let persistCalled = false;
  let redirectCalled = false;

  createWindowStub('https://example.test/editor/?localDraftId=draft_1');

  const gate = new SharedAuthGate({
    appArea: 'editor',
    resumeFlagKey: 'editor:lastSession',
    storage,
    isAuthenticated: () => false,
    getCurrentLocalId: () => 'draft_1',
    getCurrentUiState: () => ({ mode: 'edit' }),
    persistLocalRecord: async () => {
      persistCalled = true;
    },
    redirectToAuth: () => {
      redirectCalled = true;
    },
  });

  const result = await gate.runProtectedAction({
    actionId: 'resumePublishAfterLogin',
  });

  assert.equal(result.status, 'invalid_intent');
  assert.equal(persistCalled, false);
  assert.equal(redirectCalled, false);
  assert.equal(storage.pendingIntent.get(), null);
  assert.equal(storage.resumeFlags.get('editor:lastSession'), null);
});

test('restoreAfterAuthReturn restores and replays valid intent', async () => {
  const storage = createStorage();
  const callLog = [];
  storage.pendingIntent.set({
    appArea: 'viewer',
    actionId: 'resumeAttemptSyncAfterLogin',
    recordStore: 'localAttempts',
    localId: 'attempt_1',
    resumeFlagKey: 'viewer:lastSession',
    resumeUi: { status: 'in_progress' },
  });

  globalThis.window = {
    location: { href: 'https://example.test/viewer/?auth=1&authReturn=1' },
    history: {
      replaceState: () => {},
    },
  };

  const gate = new SharedAuthGate({
    appArea: 'viewer',
    resumeFlagKey: 'viewer:lastSession',
    storage,
    isAuthenticated: () => true,
    restoreByLocalId: async (localId) => {
      callLog.push(['restore', localId]);
      return true;
    },
    restoreUiState: async (ui) => callLog.push(['ui', ui.status]),
    validateIntent: async (intent) => {
      callLog.push(['validate', intent.actionId]);
      return true;
    },
    replayIntent: async (intent) => callLog.push(['replay', intent.actionId]),
  });

  const result = await gate.restoreAfterAuthReturn();

  assert.equal(result.status, 'replayed');
  assert.deepEqual(callLog, [
    ['restore', 'attempt_1'],
    ['ui', 'in_progress'],
    ['validate', 'resumeAttemptSyncAfterLogin'],
    ['replay', 'resumeAttemptSyncAfterLogin'],
  ]);
  assert.equal(storage.pendingIntent.get(), null);
});

test('restoreAfterAuthReturn returns not_authenticated and cleans URL params', async () => {
  const storage = createStorage();
  const callLog = [];
  storage.pendingIntent.set({
    appArea: 'viewer',
    actionId: 'resumeAttemptSyncAfterLogin',
    recordStore: 'localAttempts',
    localId: 'attempt_1',
    resumeFlagKey: 'viewer:lastSession',
    resumeUi: { status: 'in_progress' },
  });

  const { replaceCalls } = createWindowStub('https://example.test/viewer/?authReturn=1&intent=resumeAttemptSyncAfterLogin');

  const gate = new SharedAuthGate({
    appArea: 'viewer',
    resumeFlagKey: 'viewer:lastSession',
    storage,
    isAuthenticated: () => false,
    restoreByLocalId: async () => {
      callLog.push('restore');
      return true;
    },
    replayIntent: async () => {
      callLog.push('replay');
    },
    onRecoveryMessage: (message) => callLog.push(message),
  });

  const result = await gate.restoreAfterAuthReturn();

  assert.equal(result.status, 'not_authenticated');
  assert.equal(callLog.includes('restore'), false);
  assert.equal(callLog.includes('replay'), false);
  assert.equal(storage.pendingIntent.get().actionId, 'resumeAttemptSyncAfterLogin');
  assert.equal(replaceCalls.length, 1);
  const nextUrl = replaceCalls[0][2];
  assert.equal(nextUrl.includes('authReturn='), false);
  assert.equal(nextUrl.includes('intent='), false);
});

test('restoreAfterAuthReturn missing_local_id clears pending and cleans URL params', async () => {
  const storage = createStorage();
  storage.pendingIntent.set({
    appArea: 'viewer',
    actionId: 'resumeAttemptSyncAfterLogin',
    recordStore: 'localAttempts',
    resumeFlagKey: 'viewer:lastSession',
  });

  const { replaceCalls } = createWindowStub('https://example.test/viewer/?auth=1&authReturn=1');

  const gate = new SharedAuthGate({
    appArea: 'viewer',
    resumeFlagKey: 'viewer:lastSession',
    storage,
    isAuthenticated: () => true,
  });

  const result = await gate.restoreAfterAuthReturn();

  assert.equal(result.status, 'missing_local_id');
  assert.equal(storage.pendingIntent.get(), null);
  assert.equal(replaceCalls.length, 1);
  const nextUrl = replaceCalls[0][2];
  assert.equal(nextUrl.includes('authReturn='), false);
});

test('restoreAfterAuthReturn restore_failed clears pending and cleans URL params', async () => {
  const storage = createStorage();
  storage.pendingIntent.set({
    appArea: 'viewer',
    actionId: 'resumeAttemptSyncAfterLogin',
    recordStore: 'localAttempts',
    localId: 'attempt_1',
    resumeFlagKey: 'viewer:lastSession',
  });

  const { replaceCalls } = createWindowStub('https://example.test/viewer/?auth=1&authReturn=1&intent=resumeAttemptSyncAfterLogin');

  const gate = new SharedAuthGate({
    appArea: 'viewer',
    resumeFlagKey: 'viewer:lastSession',
    storage,
    isAuthenticated: () => true,
    restoreByLocalId: async () => false,
  });

  const result = await gate.restoreAfterAuthReturn();

  assert.equal(result.status, 'restore_failed');
  assert.equal(storage.pendingIntent.get(), null);
  assert.equal(replaceCalls.length, 1);
  const nextUrl = replaceCalls[0][2];
  assert.equal(nextUrl.includes('authReturn='), false);
  assert.equal(nextUrl.includes('intent='), false);
});

test('restoreAfterAuthReturn intent_invalid clears pending and cleans URL params', async () => {
  const storage = createStorage();
  storage.pendingIntent.set({
    appArea: 'viewer',
    actionId: 'resumeAttemptSyncAfterLogin',
    recordStore: 'localAttempts',
    localId: 'attempt_1',
    resumeFlagKey: 'viewer:lastSession',
  });

  const { replaceCalls } = createWindowStub('https://example.test/viewer/?auth=1&authReturn=1');

  const gate = new SharedAuthGate({
    appArea: 'viewer',
    resumeFlagKey: 'viewer:lastSession',
    storage,
    isAuthenticated: () => true,
    restoreByLocalId: async () => true,
    validateIntent: async () => false,
  });

  const result = await gate.restoreAfterAuthReturn();

  assert.equal(result.status, 'intent_invalid');
  assert.equal(storage.pendingIntent.get(), null);
  assert.equal(replaceCalls.length, 1);
  const nextUrl = replaceCalls[0][2];
  assert.equal(nextUrl.includes('authReturn='), false);
});
