import test from 'node:test';
import assert from 'node:assert/strict';

import {
  probeSession,
  waitForSessionReady,
  __resetSessionProbeStateForTests,
  PROBE_CACHE_TTL_MS,
} from './session-readiness.js';

test.beforeEach(() => {
  __resetSessionProbeStateForTests();
});

test('probeSession normalizes ready session', async () => {
  const apiClient = {
    getSession: async () => ({ ok: true, data: { user: { id: 'u_1' } } }),
  };

  const result = await probeSession({ apiClient });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.user, { id: 'u_1' });
  assert.equal(result.error, null);
});

test('probeSession maps auth-required states to not_ready', async () => {
  const variants = [
    { ok: false, error: { status: 401, message: 'No session' } },
    { ok: false, error: { status: 403, message: 'Denied' } },
    { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Sign in', requiresSignIn: false } },
    { ok: false, error: { code: 'X', message: 'Need auth', requiresSignIn: true } },
  ];

  for (const variant of variants) {
    const apiClient = { getSession: async () => variant };
    const result = await probeSession({ apiClient, force: true });
    assert.equal(result.status, 'not_ready');
    assert.equal(result.ok, false);
  }
});

test('probeSession caches and coalesces requests', async () => {
  let calls = 0;
  const apiClient = {
    getSession: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true, data: { user: { id: 'u_2' } } };
    },
  };

  const [a, b] = await Promise.all([
    probeSession({ apiClient }),
    probeSession({ apiClient }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);

  const cached = await probeSession({ apiClient });
  assert.equal(calls, 1);
  assert.equal(cached.status, 'ready');

  await new Promise((resolve) => setTimeout(resolve, PROBE_CACHE_TTL_MS + 30));
  await probeSession({ apiClient });
  assert.equal(calls, 2);
});

test('waitForSessionReady polls until ready with attempts and elapsed time', async () => {
  let calls = 0;
  const apiClient = {
    getSession: async () => {
      calls += 1;
      if (calls < 3) {
        return { ok: false, error: { code: 'AUTH_REQUIRED', status: 401, requiresSignIn: true } };
      }
      return { ok: true, data: { user: { id: 'u_3' } } };
    },
  };

  const result = await waitForSessionReady({
    apiClient,
    intervalMs: 20,
    timeoutMs: 500,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 3);
  assert.equal(result.timedOut, false);
  assert.ok(result.elapsedMs >= 0);
});

test('waitForSessionReady times out with not_ready status', async () => {
  const apiClient = {
    getSession: async () => ({ ok: false, error: { code: 'AUTH_REQUIRED', status: 401, requiresSignIn: true } }),
  };

  const result = await waitForSessionReady({
    apiClient,
    intervalMs: 20,
    timeoutMs: 90,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 'not_ready');
  assert.ok(result.attempts >= 1);
});
