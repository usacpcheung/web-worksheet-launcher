import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('popup login page posts auth-complete message to opener and same-origin target', async () => {
  const source = await fs.readFile(path.resolve('server/app/login/popup.html'), 'utf8');
  assert.equal(source.includes("type: 'worksheet-launcher-auth-complete'"), true);
  assert.equal(source.includes('window.opener.postMessage(payload, window.location.origin)'), true);
  assert.equal(source.includes('window.close()'), true);
});

test('popup login page contains visible fallback close-window message', async () => {
  const source = await fs.readFile(path.resolve('server/app/login/popup.html'), 'utf8');
  assert.equal(source.includes('Sign-in completed. You can close this window.'), true);
});
