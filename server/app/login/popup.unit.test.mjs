import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const popupHtmlPath = path.resolve('server/app/login/popup.html');

async function readPopupSource() {
  return fs.readFile(popupHtmlPath, 'utf8');
}

test('popup login page posts auth-complete message to opener and same-origin target', async () => {
  const source = await readPopupSource();
  assert.equal(source.includes("type: 'worksheet-launcher-auth-complete'"), true);
  assert.equal(source.includes('window.opener.postMessage(payload, window.location.origin)'), true);
});

test('popup login page checks session readiness before closing', async () => {
  const source = await readPopupSource();
  assert.equal(source.includes("fetch('/api/worksheet-launcher/v1/session', {"), true);
  assert.equal(source.includes("credentials: 'include'"), true);
  assert.equal(source.includes('if (!sessionReady) {'), true);
  assert.equal(source.includes('showNotReadyState();'), true);
  assert.equal(source.includes('window.close();'), true);
});

test('popup login page contains fallback actions when session is not ready', async () => {
  const source = await readPopupSource();
  assert.equal(source.includes('Continue sign-in'), true);
  assert.equal(source.includes('/worksheet_launcher/app/login/'), true);
  assert.equal(source.includes('Retry session check'), true);
  assert.equal(source.includes('Session is not ready yet. Continue sign-in or retry the session check.'), true);
});
