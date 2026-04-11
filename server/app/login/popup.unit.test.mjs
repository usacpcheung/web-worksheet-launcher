import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const popupHtmlPath = path.resolve('server/app/login/popup.html');
const messageContractPath = path.resolve('docs/message-contract.md');

async function readPopupSource() {
  return fs.readFile(popupHtmlPath, 'utf8');
}

async function readMessageContractSource() {
  return fs.readFile(messageContractPath, 'utf8');
}

test('popup login page posts auth-complete message to opener and same-origin target', async () => {
  const source = await readPopupSource();
  assert.equal(source.includes("type: 'worksheet-launcher-auth-complete'"), true);
  assert.equal(source.includes("const authFlowId = params.get('authFlowId') || '';"), true);
  assert.equal(source.includes('authFlowId,'), true);
  assert.equal(source.includes('window.opener.postMessage(payload, window.location.origin)'), true);
});

test('popup login page checks session readiness with bounded retries before fallback', async () => {
  const source = await readPopupSource();
  assert.equal(source.includes("import { waitForSessionReady } from '../auth/session-readiness.js';"), true);
  assert.equal(source.includes("import { AUTH_POPUP_FLOW_DEFAULTS } from '../auth/auth-popup-flow.js';"), true);
  assert.equal(source.includes("fetch('/api/worksheet-launcher/v1/session', {"), true);
  assert.equal(source.includes("credentials: 'include'"), true);
  assert.equal(source.includes('const retryDelayMs = AUTH_POPUP_FLOW_DEFAULTS.pollIntervalMs;'), true);
  assert.equal(source.includes('const maxRetryDurationMs = AUTH_POPUP_FLOW_DEFAULTS.pollTimeoutMs;'), true);
  assert.equal(source.includes('const waitResult = await waitForSessionReady({'), true);
  assert.equal(source.includes('intervalMs: retryDelayMs,'), true);
  assert.equal(source.includes('timeoutMs: maxRetryDurationMs,'), true);
  assert.equal(source.includes('if (waitResult.status !== \'ready\') {'), true);
  assert.equal(source.includes('showNotReadyState();'), true);
  assert.equal(source.includes('window.close();'), true);
});

test('popup login page keeps finalizing status during retries and only reveals fallback after exhaustion', async () => {
  const source = await readPopupSource();
  assert.equal(source.includes('Try sign-in again'), true);
  assert.equal(source.includes('/worksheet_launcher/app/login/popup.html'), true);
  assert.equal(source.includes("if (params.has('source')) {"), true);
  assert.equal(source.includes("retryUrl.searchParams.set('source', source);"), true);
  assert.equal(source.includes("if (params.has('authFlowId')) {"), true);
  assert.equal(source.includes("retryUrl.searchParams.set('authFlowId', authFlowId);"), true);
  assert.equal(source.includes("statusEl.textContent = 'Finalizing sign-in…';"), true);
  assert.equal(source.includes('const waitResult = await waitForSessionReady({'), true);
  assert.equal(source.includes(`if (waitResult.status !== 'ready') {
          showNotReadyState();
          return;
        }`), true);
  assert.equal(source.includes('Session is not ready yet. Continue sign-in in this window.'), true);
  assert.equal(source.includes('while (Date.now() <= retryDeadline) {'), false);
});

test('message contract callback schema matches popup runtime payload fields', async () => {
  const popupSource = await readPopupSource();
  const contractSource = await readMessageContractSource();
  assert.equal(contractSource.includes('"type": "worksheet-launcher-auth-complete"'), true);
  assert.equal(contractSource.includes('"source": "editor"'), true);
  assert.equal(contractSource.includes('`source` may be `editor`, `viewer`, or `generic`.'), true);
  assert.equal(contractSource.includes('"authFlowId": "auth_flow_..."'), true);
  assert.equal(popupSource.includes("type: 'worksheet-launcher-auth-complete'"), true);
  assert.equal(popupSource.includes('source,'), true);
  assert.equal(popupSource.includes('authFlowId,'), true);
});
