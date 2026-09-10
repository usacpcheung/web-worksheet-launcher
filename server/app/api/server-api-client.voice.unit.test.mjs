import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerApiClient } from './server-api-client.js';

const audio = new Blob(['synthetic fixture'], { type: 'audio/mp4' });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
function mockFetch(t, fn) { t.mock.method(globalThis, 'fetch', fn); }

test('transcription sends only multipart audio to authenticated same-origin endpoint', async (t) => {
  const controller = new AbortController();
  mockFetch(t, async (url, init) => {
    assert.equal(url, '/api/rewrite-bridge/transcriptions');
    assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'include');
    assert.equal(init.signal, controller.signal);
    assert.equal(init.headers, undefined);
    assert.ok(init.body instanceof FormData);
    assert.deepEqual([...init.body.keys()], ['audio']);
    assert.equal(await init.body.get('audio').text(), await audio.text());
    assert.equal(init.body.get('audio').type, audio.type);
    return json({ ok: true, result: ' synthetic transcript ', durationSeconds: 12.5,
      requestId: 'fixture-id', timings: { conversionMs: 1, transcriptionMs: 2, totalMs: 3 } });
  });
  assert.deepEqual(await createServerApiClient().transcribeAudio(audio, { signal: controller.signal }), {
    ok: true, status: 200, data: { text: ' synthetic transcript ', durationSeconds: 12.5,
      requestId: 'fixture-id', timings: { conversionMs: 1, transcriptionMs: 2, totalMs: 3 } },
  });
});

test('transcription stable success shape tolerates missing optional metadata', async (t) => {
  mockFetch(t, async () => json({ ok: true, result: 'fixture' }));
  assert.deepEqual((await createServerApiClient().transcribeAudio(audio)).data,
    { text: 'fixture', durationSeconds: null, requestId: null, timings: null });
});

for (const body of [
  { ok: false, error: { code: 'INVALID_UPLOAD', message: 'An audio file is required.' } },
  { ok: false, code: 'FUTURE_CODE', message: 'Future backend message.' },
]) {
  test(`preserves backend error ${body.code || body.error.code}`, async (t) => {
    mockFetch(t, async () => json(body, 400));
    const result = await createServerApiClient().transcribeAudio(new Blob());
    assert.equal(result.error.code, (body.error || body).code);
    assert.equal(result.error.message, (body.error || body).message);
    assert.equal(result.error.status, 400);
  });
}

for (const [status, contentType, body, code] of [
  [401, 'text/html', '<html>Unauthorized</html>', 'AUTH_REQUIRED'],
  [403, 'text/html', '<html>Forbidden</html>', 'AUTH_REQUIRED'],
  [200, 'text/html', '<html>Sign in</html>', 'AUTH_REQUIRED'],
  [500, 'text/html', '<html>synthetic private fixture</html>', 'UNEXPECTED_NON_JSON_RESPONSE'],
  [200, 'text/plain', 'synthetic private fixture', 'UNEXPECTED_NON_JSON_RESPONSE'],
  [200, 'application/json', '{synthetic private fixture', 'INVALID_JSON_RESPONSE'],
  [200, 'application/json', '', 'INVALID_JSON_RESPONSE'],
  [200, 'application/json', '{"ok":true,"result":"  "}', 'BRIDGE_EMPTY_RESPONSE'],
  [200, 'application/json', '{"ok":true}', 'BRIDGE_EMPTY_RESPONSE'],
  [200, 'application/json', 'null', 'API_ERROR'],
  [403, 'application/json', '{"ok":false}', 'AUTH_REQUIRED'],
]) {
  test(`transcription parses ${status} ${contentType} ${code}: ${body.slice(0, 20)}`, async (t) => {
    mockFetch(t, async () => new Response(body, { status, headers: { 'content-type': contentType } }));
    const result = await createServerApiClient().transcribeAudio(audio);
    assert.equal(result.error.code, code);
    assert.equal(result.error.requiresSignIn, code === 'AUTH_REQUIRED');
    assert.ok(!JSON.stringify(result).includes('synthetic private fixture'));
    assert.equal(result.error.details, undefined);
  });
}

test('transcription network failures do not leak exception text', async (t) => {
  mockFetch(t, async () => { throw Error('synthetic private fixture'); });
  const result = await createServerApiClient().transcribeAudio(audio);
  assert.equal(result.error.code, 'NETWORK_ERROR');
  assert.ok(!JSON.stringify(result).includes('synthetic private fixture'));
});

for (const method of ['transcribeAudio', 'rewriteText']) {
  const input = method === 'transcribeAudio' ? audio : 'synthetic fixture';
  test(`${method} already-aborted signal never sends a request`, async (t) => {
    mockFetch(t, () => assert.fail('no request expected'));
    const controller = new AbortController(); controller.abort();
    assert.equal((await createServerApiClient()[method](input, { signal: controller.signal })).error.code, 'ABORTED');
  });
  test(`${method} cancels pending fetch`, async (t) => {
    mockFetch(t, (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
    }));
    const controller = new AbortController();
    const pending = createServerApiClient()[method](input, { signal: controller.signal });
    controller.abort(); assert.equal((await pending).error.code, 'ABORTED');
  });
  for (const contentType of ['application/json', 'text/html']) {
    test(`${method} cancellation wins when body reading completes concurrently`, async (t) => {
      const controller = new AbortController();
      const body = { ok: true, result: 'fixture' };
      mockFetch(t, async () => ({ status: 200, ok: true,
        headers: new Headers({ 'content-type': contentType }),
        text: async () => { controller.abort(); return JSON.stringify(body); },
        json: async () => { controller.abort(); return body; } }));
      assert.equal((await createServerApiClient()[method](input, { signal: controller.signal })).error.code, 'ABORTED');
    });
    test(`${method} cancels during ${contentType} response body consumption`, async (t) => {
      const controller = new AbortController();
      const read = async () => { controller.abort(); throw new DOMException('Canceled', 'AbortError'); };
      mockFetch(t, async () => ({ status: 200, ok: true,
        headers: new Headers({ 'content-type': contentType }), text: read, json: read }));
      assert.equal((await createServerApiClient()[method](input, { signal: controller.signal })).error.code, 'ABORTED');
    });
  }
}

test('rewrite optional signal retains payload, credentials and success normalization', async (t) => {
  const controller = new AbortController();
  mockFetch(t, async (url, init) => {
    assert.equal(url, '/api/rewrite-bridge/rewrite');
    assert.equal(init.signal, controller.signal);
    assert.equal(init.credentials, 'include');
    assert.deepEqual(init.headers, { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(init.body), { text: 'fixture', stream: false });
    return json({ ok: true, result: ' fixture rewrite ' });
  });
  assert.deepEqual(await createServerApiClient().rewriteText('fixture', { signal: controller.signal }),
    { ok: true, data: { text: 'fixture rewrite' }, status: 200 });
});
