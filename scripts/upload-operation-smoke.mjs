import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { hashUploadRequest } from '../server/app/api/upload-operation-contract.js';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let mode = 'completed';
  let posts = 0;
  let operationId;
  let kind;
  let requestSha256;
  let reads = 0;
  await context.route('**/api/worksheet-launcher/v1/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      posts++;
      reads = 0;
      operationId = request.headers()['idempotency-key'];
      const query = new URL(request.url()).searchParams;
      const requestKind = request.url().includes('/roleplayscene/') ? 'roleplayscene-draft' : request.url().includes('/attempts/') ? 'worksheet-attempt' : 'worksheet-draft';
      requestSha256 = await hashUploadRequest(requestKind, [query.get('title'), query.get('subject') ?? query.get('description'), query.get('conflictAction')], request.postDataBuffer());
      assert.match(operationId, /^[0-9a-f-]{36}$/);
      // The server committed, but the browser never receives its POST response.
      await route.abort('failed');
      return;
    }
    assert.ok(request.url().endsWith(`/upload-operations/${operationId}`));
    reads++;
    if (mode === 'cancel') await new Promise(resolve => setTimeout(resolve, 300));
    const data = mode === 'unknown' || (mode === 'late' && reads === 1) ? { operationId, state: 'unknown' } : {
      operationId, kind, requestSha256, state: 'completed', result: { ok: true, statusCode: 201, data: { saved: 'original' } },
    };
    await route.fulfill({ json: { ok: true, data } }).catch(() => {});
  });
  await page.goto(`${base}/server/app/api/server-api-client.js`);
  for (const [method, uploadKind] of [
    ['uploadDraftPackage', 'worksheet-draft'], ['uploadAttemptPackage', 'worksheet-attempt'],
    ['uploadRolePlaySceneDraftPackage', 'roleplayscene-draft'],
  ]) {
    kind = uploadKind;
    const result = await page.evaluate(async method => {
      const { createServerApiClient } = await import('/server/app/api/server-api-client.js');
      return createServerApiClient()[method](new Uint8Array([1]), { title: 'Fixture' });
    }, method);
    assert.equal(result.ok, true);
    assert.equal(result.recovered, true);
    assert.equal(result.data.saved, 'original');
    assert.equal(result.operationId, operationId);
  }
  assert.equal(posts, 3, 'no automatic POST retries');
  mode = 'late';
  for (const [method, uploadKind] of [
    ['uploadDraftPackage', 'worksheet-draft'], ['uploadAttemptPackage', 'worksheet-attempt'],
    ['uploadRolePlaySceneDraftPackage', 'roleplayscene-draft'],
  ]) {
    kind = uploadKind;
    const result = await page.evaluate(async method => {
      const { createServerApiClient } = await import('/server/app/api/server-api-client.js');
      return createServerApiClient()[method](new Uint8Array([1]), { title: '工作紙 & + \ud800' });
    }, method);
    assert.equal(result.recovered, true);
    assert.equal(reads, 2, 'unknown status is polled until the receipt becomes visible');
  }
  assert.equal(posts, 6, 'late commits do not trigger POST retries');
  mode = 'unknown';
  const unknown = await page.evaluate(async () => {
    const { createServerApiClient } = await import('/server/app/api/server-api-client.js');
    return createServerApiClient({ operationLookupTimeoutMs: 100 }).uploadDraftPackage(new Uint8Array([1]));
  });
  assert.equal(unknown.error.code, 'NETWORK_ERROR');
  assert.equal(unknown.operationId, operationId);
  assert.equal(posts, 7);
  mode = 'cancel';
  const lookup = page.waitForRequest(request => request.url().includes('/upload-operations/'));
  const pending = page.evaluate(async () => {
    const { createServerApiClient } = await import('/server/app/api/server-api-client.js');
    window.recoveryController = new AbortController();
    return createServerApiClient().uploadDraftPackage(new Uint8Array([1]), {}, { signal: window.recoveryController.signal });
  });
  await lookup;
  await page.evaluate(() => window.recoveryController.abort());
  assert.equal((await pending).error.code, 'ABORTED');
  assert.equal(posts, 8);
  assert.deepEqual(pageErrors, []);
  console.log('PASS: real XHR lost-response and late-commit recovery for all uploads, URL metadata fingerprinting, bounded unknown status without resend, and lookup cancellation');
  await context.close();
} finally {
  await browser.close();
}
