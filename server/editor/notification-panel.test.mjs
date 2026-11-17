import test from 'node:test';
import assert from 'node:assert/strict';
import { getNotificationToastRemainingMs } from './notification-panel.js';

test('toast lifetime stays anchored to notification creation across language rerenders', async () => {
  const createdAt = '2026-07-14T00:00:00.000Z';
  const createdAtMs = new Date(createdAt).getTime();
  const notification = { id: 'notif_audio', createdAt, ttlMs: null, showToast: true };

  assert.equal(getNotificationToastRemainingMs(notification, createdAtMs), 5000);
  assert.equal(getNotificationToastRemainingMs(notification, createdAtMs + 3000), 2000);
  assert.equal(getNotificationToastRemainingMs(notification, createdAtMs + 5000), 0);
  assert.equal(getNotificationToastRemainingMs(notification, createdAtMs + 9000), 0);
  assert.equal(getNotificationToastRemainingMs({ ...notification, ttlMs: 1200 }, createdAtMs + 200), 1000);
  assert.equal(getNotificationToastRemainingMs({ ...notification, showToast: false }, createdAtMs), 0);
});

test('toast duration rejects invalid records and preserves default/future-time bounds', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  assert.equal(getNotificationToastRemainingMs(null, now), 0);
  assert.equal(getNotificationToastRemainingMs({ createdAt: 'invalid' }, now), 0);
  assert.equal(getNotificationToastRemainingMs({ createdAt: new Date(now).toISOString() }, NaN), 0);
  const future = { createdAt: new Date(now + 1000).toISOString(), ttlMs: 1200 };
  assert.equal(getNotificationToastRemainingMs(future, now), 1200);
  const notification = { createdAt: new Date(now - 1000).toISOString(), ttlMs: -1 };
  assert.equal(getNotificationToastRemainingMs(notification, now), 4000);
});
