import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEYS, setPendingIntent, getPendingIntent, clearPendingIntent } from './local-storage.js';
const memory = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) }; };
test('pending intents survive navigation in one tab and cannot overwrite or clear another tab', () => {
  globalThis.localStorage = memory();
  const a = memory(), b = memory();
  globalThis.sessionStorage = a; setPendingIntent({localId:'A'});
  const original = getPendingIntent();
  globalThis.sessionStorage = b; setPendingIntent({localId:'B'});
  assert.equal(getPendingIntent().localId, 'B');
  globalThis.sessionStorage = a; assert.deepEqual(getPendingIntent(), original); clearPendingIntent();
  globalThis.sessionStorage = b; assert.equal(getPendingIntent().localId, 'B');
  assert.equal(localStorage.getItem(STORAGE_KEYS.pendingIntent), null);
});
test('only a login return adopts legacy intent; cancellation cannot resurrect it', () => {
  globalThis.localStorage = memory(); globalThis.sessionStorage = memory();
  localStorage.setItem(STORAGE_KEYS.pendingIntent, JSON.stringify({localId:'legacy'}));
  globalThis.location = {href:'https://fixture.test/viewer/'};
  assert.equal(getPendingIntent(), null);
  globalThis.location.href += '?authReturn=1';
  assert.equal(getPendingIntent().localId, 'legacy');
  assert.equal(localStorage.getItem(STORAGE_KEYS.pendingIntent), null);
  clearPendingIntent();
  localStorage.setItem(STORAGE_KEYS.pendingIntent, JSON.stringify({localId:'another legacy flow'}));
  assert.equal(getPendingIntent(), null);
});
