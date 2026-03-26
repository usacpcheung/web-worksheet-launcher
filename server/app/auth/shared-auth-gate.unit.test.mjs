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
