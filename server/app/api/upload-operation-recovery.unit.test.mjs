import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerApiClient } from './server-api-client.js';
import { hashUploadRequest } from './upload-operation-contract.js';
import { createUploadOperation } from '../../api/services/upload-operation.js';

const id = '11111111-1111-4111-8111-111111111111';
globalThis.window = undefined;
globalThis.XMLHttpRequest = undefined;
function setup(t) {
  t.mock.property(globalThis, 'window', { location: { origin: 'https://example.test' } });
  t.mock.property(globalThis, 'XMLHttpRequest', undefined);
}
const json = data => new Response(JSON.stringify({ ok: true, data }), { headers: { 'content-type': 'application/json' } });
const hashes = Object.fromEntries(await Promise.all(['worksheet-draft', 'worksheet-attempt', 'roleplayscene-draft'].map(async kind => [kind, await hashUploadRequest(kind, ['', '', ''], new Uint8Array([1]))])));
const receipt = kind => ({ operationId: id, kind, requestSha256: hashes[kind], state: 'completed', result: { ok: true, statusCode: 201, data: { saved: 'original', upload_operation_id: id } } });

test('recovery waits for an in-flight transaction and tolerates a transient status failure', async t => {
  setup(t);
  let posts = 0;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'POST') { posts++; throw Error('connection reset before commit'); }
    reads++;
    if (reads === 1) return json({ operationId: id, state: 'unknown' });
    if (reads === 2) return new Response('Gateway unavailable', { status: 503 });
    return json(receipt('worksheet-draft'));
  });
  const result = await createServerApiClient({ operationLookupTimeoutMs: 2000 }).uploadDraftPackage(new Uint8Array([1]), {}, { operationId: id });
  assert.equal(result.recovered, true);
  assert.equal(posts, 1);
  assert.equal(reads, 3);
});

test('recovery fingerprints the actual URL metadata, including repaired lone UTF-16 surrogates', async t => {
  setup(t);
  let requestSha256;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'POST') {
      const query = new URL(url, window.location.origin).searchParams;
      requestSha256 = createUploadOperation({ operationId: id, kind: 'worksheet-draft',
        metadata: [query.get('title'), query.get('subject'), query.get('conflictAction')], zipBytes: options.body }).requestHash;
      throw Error('lost response');
    }
    return json({ ...receipt('worksheet-draft'), requestSha256 });
  });
  const result = await createServerApiClient().uploadDraftPackage(new Uint8Array([1]), { title: 'Pasted \ud800 text & + 工作紙' }, { operationId: id });
  assert.equal(result.recovered, true);
});

test('browser and server fingerprints agree on exact Unicode metadata, bytes and conflict action', async () => {
  for (const kind of Object.keys(hashes)) {
    const metadata = [' 工作紙 & + ', 'Subject\n描述', ' COPY '];
    const zipBytes = new Uint8Array([0, 1, 128, 255]);
    const server = createUploadOperation({ operationId: id, kind, metadata, zipBytes });
    assert.equal(await hashUploadRequest(kind, metadata, new Blob([zipBytes])), server.requestHash);
    assert.notEqual(await hashUploadRequest(kind, metadata.map(value => value.trim()), zipBytes), server.requestHash);
    assert.notEqual(await hashUploadRequest(kind, metadata, new Uint8Array([0, 1, 128, 254])), server.requestHash);
  }
});

test('mutable upload bytes are snapshotted before hashing, and cancellation before transport sends nothing', async t => {
  setup(t);
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'POST') {
      posts++;
      assert.deepEqual([...options.body], [1]);
      throw Error('lost response');
    }
    return json(receipt('worksheet-draft'));
  });
  const client = createServerApiClient();
  const bytes = new Uint8Array([1]);
  const pending = client.uploadDraftPackage(bytes, {}, { operationId: id });
  bytes[0] = 2;
  assert.equal((await pending).recovered, true);
  const controller = new AbortController();
  const canceled = client.uploadDraftPackage(bytes, {}, { signal: controller.signal });
  controller.abort();
  assert.equal((await canceled).error.code, 'ABORTED');
  assert.equal(posts, 1);
});

test('all upload kinds recover a lost response by reading their committed receipt, without resending', async t => {
  setup(t);
  for (const [method, kind] of [
    ['uploadDraftPackage', 'worksheet-draft'], ['uploadAttemptPackage', 'worksheet-attempt'],
    ['uploadRolePlaySceneDraftPackage', 'roleplayscene-draft'],
  ]) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') {
        assert.equal(options.headers['idempotency-key'], id);
        throw new Error('reply lost after commit');
      }
      assert.ok(url.endsWith(`/upload-operations/${id}`));
      assert.equal(options.cache, 'no-store');
      return json(receipt(kind));
    });
    const result = await createServerApiClient()[method](new Uint8Array([1]), {}, { operationId: id });
    assert.equal(result.ok, true);
    assert.equal(result.recovered, true);
    assert.equal(result.data.saved, 'original');
    assert.deepEqual(calls.map(c => c.options.method), ['POST', 'GET']);
  }
});

test('unknown, wrong-operation and older-server responses never authorize another POST or a false success', async t => {
  setup(t);
  for (const response of [
    { operationId: id, state: 'unknown' },
    { ...receipt('worksheet-draft'), operationId: '22222222-2222-4222-8222-222222222222' },
    receipt('worksheet-attempt'),
    { ...receipt('worksheet-draft'), requestSha256: 'different-content' },
    null,
  ]) {
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      if (options.method === 'POST') { posts++; throw Error('offline'); }
      return response ? json(response) : new Response('Not found', { status: 404 });
    });
    const result = await createServerApiClient().uploadDraftPackage(new Uint8Array([1]), {}, { operationId: id });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NETWORK_ERROR');
    assert.equal(result.operationId, id);
    assert.equal(posts, 1);
  }
});

test('status lookup has a body-read deadline and cancellation releases the upload flow', async t => {
  setup(t);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'POST') throw Error('reset');
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } });
  });
  const client = createServerApiClient({ operationLookupTimeoutMs: 10 });
  const timedOut = await client.uploadDraftPackage(new Uint8Array([1]), {}, { operationId: id });
  assert.equal(timedOut.error.code, 'NETWORK_ERROR');
  assert.equal((await client.getUploadOperation(id)).error.code, 'REQUEST_TIMEOUT');

  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'POST') throw Error('reset');
    controller.abort();
    return json(receipt('worksheet-draft'));
  });
  const canceled = await client.uploadDraftPackage(new Uint8Array([1]), {}, { operationId: id, signal: controller.signal });
  assert.equal(canceled.error.code, 'ABORTED');
});

test('XHR sends the caller operation ID and network failure recovers through the same lookup', async t => {
  setup(t);
  globalThis.XMLHttpRequest = class {
    constructor() { this.headers = {}; }
    open() {}
    setRequestHeader(key, value) { this.headers[key] = value; }
    send() { assert.equal(this.headers['idempotency-key'], id); this.onerror(); }
  };
  t.after(() => { globalThis.XMLHttpRequest = undefined; });
  t.mock.method(globalThis, 'fetch', async () => json(receipt('worksheet-attempt')));
  const result = await createServerApiClient().uploadAttemptPackage(new Uint8Array([1]), {}, { operationId: id });
  assert.equal(result.recovered, true);
});

test('each new upload gets a distinct UUID; a supplied invalid ID sends nothing', async t => {
  setup(t);
  const ids = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { ids.push(options.headers['idempotency-key']); return json({ saved: true }); });
  const client = createServerApiClient();
  for (let i = 0; i < 2; i++) {
    const result = await client.uploadDraftPackage(new Uint8Array([1]));
    assert.equal(result.operationId, ids.at(-1));
  }
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every(value => /^[0-9a-f-]{36}$/.test(value)));
  assert.equal((await client.uploadDraftPackage(new Uint8Array([1]), {}, { operationId: 'invalid' })).error.code, 'INVALID_UPLOAD_OPERATION_ID');
  assert.equal((await client.getUploadOperation('invalid')).error.code, 'INVALID_UPLOAD_OPERATION_ID');
  assert.equal(ids.length, 2);
});
