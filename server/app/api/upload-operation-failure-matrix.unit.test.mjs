import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerApiClient } from './server-api-client.js';
import { createUploadOperation } from '../../api/services/upload-operation.js';

const id = 'A1111111-1111-4111-8111-111111111111';
const normalizedId = id.toLowerCase();
const bytes = new Uint8Array([1, 2, 3]);
const methods = [
  ['uploadDraftPackage', 'worksheet-draft'],
  ['uploadAttemptPackage', 'worksheet-attempt'],
  ['uploadRolePlaySceneDraftPackage', 'roleplayscene-draft'],
];
const json = (data, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'content-type': 'application/json' } });
const completed = kind => ({ operationId: normalizedId, state: 'completed', kind,
  requestSha256: createUploadOperation({ operationId: id, kind, metadata: ['', '', ''], zipBytes: bytes }).requestHash,
  result: { ok: true, statusCode: 201, data: { saved: true } } });
globalThis.window = undefined;
globalThis.XMLHttpRequest = undefined;
function setup(t) {
  t.mock.property(globalThis, 'window', { location: { origin: 'https://example.test' } });
  t.mock.property(globalThis, 'XMLHttpRequest', undefined);
}
const cases = [
  { name: 'normal success', status: 201, text: '{"ok":true,"data":{"saved":true}}', success: true },
  { name: 'connection reset', event: 'error', recover: true },
  { name: 'stalled headers', event: 'stall', recover: true },
  { name: 'stalled response body', event: 'body-stall', recover: true },
  { name: 'interrupted response body', event: 'body-reset', recover: true },
  { name: 'malformed success JSON', status: 200, text: '{', recover: true },
  { name: 'unexpected plain-text success', status: 200, text: 'truncated reply', type: 'text/plain', recover: true },
  { name: 'gateway HTML error', status: 502, text: '<html>Bad gateway</html>', type: 'text/html', recover: true },
  { name: 'server JSON error', status: 500, text: '{"ok":false,"error":{"code":"INTERNAL_ERROR"}}', recover: true },
  { name: 'sign-in required', status: 401, text: '{"ok":false}' },
  { name: 'malformed authentication error', status: 401, text: '{' },
  { name: 'malformed forbidden error', status: 403, text: '{' },
  { name: 'forbidden HTML', status: 403, text: '<html>Forbidden</html>', type: 'text/html' },
  { name: 'conflict', status: 409, text: '{"ok":false,"error":{"code":"UPLOAD_OPERATION_MISMATCH"}}' },
  { name: 'oversize malformed error', status: 413, text: '{' },
  { name: 'rate limit', status: 429, text: '{"ok":false}' },
  { name: 'login redirect HTML', status: 200, text: '<html>Sign in</html>', type: 'text/html' },
];
for (const status of [401, 409, 413]) for (const stalled of [false, true]) {
  test(`fetch keeps HTTP ${status} authoritative when its error body ${stalled ? 'stalls' : 'disconnects'}`, async t => {
    setup(t);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
      calls++;
      assert.equal(request.method, 'POST', 'an explicit rejection must not query an old receipt');
      return new Response(new ReadableStream({ start(controller) { if (!stalled) controller.error(Error('body reset')); } }), {
        status, headers: { 'content-type': 'application/json' },
      });
    });
    const result = await createServerApiClient({ uploadTimeoutMs: 15 }).uploadDraftPackage(bytes, {}, { operationId: id });
    assert.equal(result.ok, false);
    assert.equal(result.error.status, status);
    assert.equal(result.error.requiresSignIn, status === 401);
    assert.equal(calls, 1);
  });
}
for (const [method, kind] of methods) for (const transport of ['fetch', 'XHR']) for (const fixture of cases) {
  test(`${method}/${transport}: ${fixture.name}`, async t => {
    setup(t);
    let posts = 0;
    let reads = 0;
    const options = { uploadTimeoutMs: 15, operationLookupTimeoutMs: 1000 };
    const post = () => {
      posts++;
      if (fixture.event === 'error') throw Error('network reset');
      if (fixture.event === 'stall') return new Promise(() => {});
      if (fixture.event === 'body-stall') return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
      if (fixture.event === 'body-reset') return new Response(new ReadableStream({ start(c) { c.error(Error('response reset')); } }), { headers: { 'content-type': 'application/json' } });
      return new Response(fixture.text, { status: fixture.status, headers: { 'content-type': fixture.type || 'application/json' } });
    };
    t.mock.method(globalThis, 'fetch', async (url, request) => {
      if (request.method === 'POST') {
        assert.equal(request.headers['idempotency-key'], normalizedId);
        return post();
      }
      reads++;
      assert.ok(url.endsWith(normalizedId));
      assert.equal(request.cache, 'no-store');
      return json(completed(kind));
    });
    if (transport === 'XHR') {
      globalThis.XMLHttpRequest = class {
        open() {}
        setRequestHeader(name, value) { if (name === 'idempotency-key') assert.equal(value, normalizedId); }
        abort() { this.onabort?.(); }
        getResponseHeader() { return fixture.type || 'application/json'; }
        send() {
          posts++;
          if (fixture.event?.includes('stall')) return;
          if (fixture.event) { this.onerror(); return; }
          this.status = fixture.status;
          this.responseText = fixture.text;
          this.onload();
        }
      };
      t.after(() => { globalThis.XMLHttpRequest = undefined; });
    }
    const result = await createServerApiClient(options)[method](bytes, {}, { operationId: id });
    assert.equal(result.ok, !!(fixture.success || fixture.recover));
    assert.equal(result.recovered === true, !!fixture.recover);
    assert.equal(result.operationId, normalizedId);
    if (fixture.status === 401 || fixture.status === 403) {
      assert.equal(result.error.requiresSignIn, true);
      assert.equal(result.error.code, 'AUTH_REQUIRED');
    }
    assert.equal(posts, 1);
    assert.equal(reads, fixture.recover ? 1 : 0);
  });
}

for (const status of [401, 403, 409, 413, 429, 200, 503]) for (const event of ['error', 'timeout', 'deadline']) {
  test(`XHR retains HTTP ${status} after headers then ${event}`, async t => {
    setup(t);
    let reads = 0;
    globalThis.XMLHttpRequest = class {
      open() {}
      setRequestHeader() {}
      abort() { this.status = 0; this.onabort?.(); }
      send() {
        this.readyState = 2; this.status = status; this.onreadystatechange();
        if (event === 'deadline') return;
        this.readyState = 4; this.status = 0; this.onreadystatechange();
        if (event === 'error') this.onerror();
        else this.ontimeout();
      }
    };
    t.after(() => { globalThis.XMLHttpRequest = undefined; });
    t.mock.method(globalThis, 'fetch', async () => { reads++; return json(completed('worksheet-draft')); });
    const result = await createServerApiClient({ uploadTimeoutMs: 15 }).uploadDraftPackage(bytes, {}, { operationId: id });
    const rejected = status >= 400 && status < 500;
    assert.equal(result.ok, !rejected);
    assert.equal(reads, rejected ? 0 : 1);
    if (rejected) {
      assert.equal(result.error.status, status);
      assert.equal(result.error.requiresSignIn, status === 401 || status === 403);
    } else assert.equal(result.recovered, true);
  });
}

test('status recovery shares one deadline across polling and a stalled body', { timeout: 3000 }, async t => {
  setup(t);
  let reads = 0;
  let statusSignal;
  let lastDeadline;
  let secondDeadline;
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    lastDeadline = delay;
    return schedule(callback, delay, ...args);
  });
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    if (request.method === 'POST') throw Error('reset');
    reads++;
    if (reads === 1) return json({ operationId: normalizedId, state: 'unknown' });
    statusSignal = request.signal;
    secondDeadline = lastDeadline;
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
  });
  const result = await createServerApiClient({ operationLookupTimeoutMs: 400 }).uploadDraftPackage(bytes, {}, { operationId: id });
  assert.equal(result.error.code, 'NETWORK_ERROR');
  assert.equal(reads, 2);
  assert.equal(statusSignal.aborted, true);
  assert.ok(secondDeadline > 0 && secondDeadline < 200, `the second read must use the remaining budget: ${secondDeadline}ms`);
});

test('cancel during polling backoff settles without another lookup or upload', async t => {
  setup(t);
  const controller = new AbortController();
  let reads = 0;
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    if (request.method === 'POST') { posts++; throw Error('reset'); }
    reads++;
    setTimeout(() => controller.abort(), 10);
    return json({ operationId: normalizedId, state: 'unknown' });
  });
  const result = await createServerApiClient().uploadAttemptPackage(bytes, {}, { operationId: id, signal: controller.signal });
  assert.equal(result.error.code, 'ABORTED');
  assert.equal(reads, 1);
  assert.equal(posts, 1);
});

for (const [name, status, body] of [['old API', 404, 'missing'], ['expired auth', 401, '{'], ['forbidden', 403, '{"ok":false}']]) {
  test(`status ${name} stops recovery immediately`, async t => {
    setup(t);
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
      if (request.method === 'POST') throw Error('reset');
      reads++;
      return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    });
    const result = await createServerApiClient().uploadDraftPackage(bytes, {}, { operationId: id });
    assert.equal(result.error.code, 'NETWORK_ERROR');
    assert.equal(reads, 1);
  });
}

for (const mode of ['no UUID', 'no digest', 'digest fails']) {
  test(`legacy capability: ${mode} still uploads without unsafe recovery`, async t => {
    setup(t);
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
      randomUUID: mode === 'no UUID' ? undefined : () => normalizedId,
      subtle: mode === 'no digest' ? undefined : { async digest() { throw Error('unavailable'); } },
    } });
    t.after(() => Object.defineProperty(globalThis, 'crypto', originalCrypto));
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['idempotency-key'], mode === 'no UUID' ? undefined : normalizedId);
      posts++;
      throw Error('offline');
    });
    const result = await createServerApiClient().uploadDraftPackage(bytes);
    assert.equal(result.error.code, 'NETWORK_ERROR');
    assert.equal(posts, 1);
  });
}

for (const [name, body] of [
  ['ArrayBuffer', bytes.buffer], ['Blob', new Blob([bytes])],
  ['offset Uint8Array', new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4)],
  ['offset DataView', new DataView(new Uint8Array([99, 1, 2, 3, 99]).buffer, 1, 3)],
]) {
  test(`ZIP representation: ${name} fingerprints and sends the same bytes`, async t => {
    setup(t);
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
      if (request.method === 'POST') {
        assert.deepEqual(new Uint8Array(await new Response(request.body).arrayBuffer()), bytes);
        throw Error('lost response');
      }
      return json(completed('worksheet-draft'));
    });
    assert.equal((await createServerApiClient().uploadDraftPackage(body, {}, { operationId: id })).recovered, true);
  });
}
