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

test('popup login page checks session readiness with bounded retries before fallback', async () => {
  const source = await readPopupSource();
  assert.equal(source.includes("fetch('/api/worksheet-launcher/v1/session', {"), true);
  assert.equal(source.includes("credentials: 'include'"), true);
  assert.equal(source.includes('const retryDelayMs = 1000;'), true);
  assert.equal(source.includes('const maxRetryDurationMs = 15000;'), true);
  assert.equal(source.includes('while (Date.now() <= retryDeadline) {'), true);
  assert.equal(source.includes('await sleep(retryDelayMs);'), true);
  assert.equal(source.includes('if (!sessionReady) {'), true);
  assert.equal(source.includes('showNotReadyState();'), true);
  assert.equal(source.includes('window.close();'), true);
});

test('popup login page keeps finalizing status during retries and only reveals fallback after exhaustion', async () => {
  const source = await readPopupSource();
  assert.equal(source.includes('Try sign-in again'), true);
  assert.equal(source.includes('/worksheet_launcher/app/login/popup.html'), true);
  assert.equal(source.includes("if (params.has('source')) {"), true);
  assert.equal(source.includes("retryUrl.searchParams.set('source', source);"), true);
  assert.equal(source.includes("statusEl.textContent = 'Finalizing sign-in…';"), true);
  assert.equal(source.includes('while (Date.now() <= retryDeadline) {'), true);
  assert.equal(source.includes(`if (!sessionReady) {
          showNotReadyState();
          return;
        }`), true);
  assert.equal(source.includes('Session is not ready yet. Continue sign-in in this window.'), true);
});
