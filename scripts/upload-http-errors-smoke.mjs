import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { hashUploadRequest } from '../server/app/api/upload-operation-contract.js';

// Unlike route.fulfill mocks, this server sends real response headers followed
// by an incomplete body, exercising Chromium's XHR ready-state/error behavior.
const modules = new Map(await Promise.all(['server-api-client', 'published-packages-service', 'upload-operation-contract'].map(async name =>
  [`/server/app/api/${name}.js`, await readFile(new URL(`../server/app/api/${name}.js`, import.meta.url))])));
let status = 413;
let mode = 'stall';
let reads = 0;
let operationId;
let requestSha256;
const timers = new Set();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (modules.has(url.pathname)) {
    res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(modules.get(url.pathname)); return;
  }
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    operationId = req.headers['idempotency-key'];
    requestSha256 = await hashUploadRequest('worksheet-draft', ['', '', ''], Buffer.concat(chunks));
    if (mode === 'non-json') {
      res.writeHead(status, { 'content-type': 'text/plain' }); res.end('unexpected response'); return;
    }
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': '10000' });
    res.flushHeaders();
    res.write('{');
    if (mode === 'reset') {
      const timer = setTimeout(() => { timers.delete(timer); res.destroy(); }, 100);
      timers.add(timer);
    }
    return;
  }
  if (url.pathname.includes('/upload-operations/')) {
    reads++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { operationId, requestSha256, kind: 'worksheet-draft', state: 'completed',
      result: { ok: true, statusCode: 201, data: { saved: 'old receipt' } } } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>HTTP upload fixture</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const code of [401, 403, 409, 413, 429, 200, 503]) for (const failure of ['stall', 'reset', 'non-json']) {
    status = code; mode = failure; reads = 0;
    const result = await page.evaluate(async () => {
      const { createServerApiClient } = await import('/server/app/api/server-api-client.js');
      return createServerApiClient({ uploadTimeoutMs: 700, operationLookupTimeoutMs: 1000 }).uploadDraftPackage(new Uint8Array([1]));
    });
    const rejected = code >= 400 && code < 500;
    assert.equal(result.ok, !rejected, `${code}/${failure}: ${JSON.stringify(result)}`);
    assert.equal(reads, rejected ? 0 : 1, `${code}/${failure} status lookups`);
    if (rejected) {
      assert.equal(result.error.status, code);
      assert.equal(result.error.requiresSignIn, code === 401 || code === 403);
    } else assert.equal(result.recovered, true);
  }
  assert.deepEqual(pageErrors, []);
  console.log('PASS: real XHR retains 4xx headers across stalls/resets and still recovers uncertain 2xx/5xx and non-JSON uploads');
} finally {
  await browser?.close();
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
