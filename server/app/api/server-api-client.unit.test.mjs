import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerApiClient } from './server-api-client.js';

function mockJsonResponse(status, payload, headers = { 'content-type': 'application/json; charset=utf-8' }) {
  return new Response(JSON.stringify(payload), { status, headers });
}

function setTestWindow(search = '') {
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search,
    },
  };
}

test('createServerApiClient uses production public base path by default', async () => {
  setTestWindow();
  globalThis.fetch = async () => mockJsonResponse(200, { ok: true, data: { ready: true } });

  const client = createServerApiClient();
  assert.equal(client.publicApiBase, '/api/worksheet-launcher/v1');
  await client.getSession();
});

test('getSession builds canonical public API URL', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return mockJsonResponse(200, { ok: true, data: { ready: true } });
  };

  const client = createServerApiClient();
  await client.getSession();
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/session');
});

test('getSessionSignInUrl builds popup login path under app/login', async () => {
  setTestWindow();

  const client = createServerApiClient();
  assert.equal(client.getSessionSignInUrl(), '/worksheet_launcher/app/login/popup.html');
  assert.equal(
    client.getSessionSignInUrl({ source: 'editor' }),
    '/worksheet_launcher/app/login/popup.html?source=editor'
  );
  assert.equal(
    client.getSessionSignInUrl({ source: 'editor', authFlowId: 'auth_flow_123' }),
    '/worksheet_launcher/app/login/popup.html?source=editor&authFlowId=auth_flow_123'
  );
});

test('listUploadedDrafts builds canonical public API URL', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return mockJsonResponse(200, { ok: true, data: [] });
  };

  const client = createServerApiClient();
  await client.listUploadedDrafts();
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/drafts');
});

test('getSession returns structured AUTH_REQUIRED for html auth redirect-like responses', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response('<html>login</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

  const client = createServerApiClient();
  const result = await client.getSession();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTH_REQUIRED');
  assert.equal(result.error.requiresSignIn, true);
});

test('fetchPublishedPackageArtifact parses zip payload', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
    status: 200,
    headers: { 'content-type': 'application/zip' },
  });

  const client = createServerApiClient();
  const result = await client.fetchPublishedPackageArtifact('abc');
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.data), [0x50, 0x4b, 0x03, 0x04]);
});

test('deleteUploadedDraft sends DELETE to canonical drafts path', async () => {
  setTestWindow();
  let requestedUrl = null;
  let requestedMethod = null;
  globalThis.fetch = async (url, request = {}) => {
    requestedUrl = url;
    requestedMethod = request.method;
    return mockJsonResponse(200, { ok: true, data: { deleted: true } });
  };

  const client = createServerApiClient();
  const result = await client.deleteUploadedDraft('550e8400-e29b-41d4-a716-446655440000');
  assert.equal(result.ok, true);
  assert.equal(requestedUrl, '/api/worksheet-launcher/v1/drafts/550e8400-e29b-41d4-a716-446655440000');
  assert.equal(requestedMethod, 'DELETE');
});

test('publishFromUploadedDraft sends uploadedDraftId with title and subject overrides', async () => {
  setTestWindow();
  let requestBody = null;
  globalThis.fetch = async (_url, request = {}) => {
    requestBody = request.body;
    return mockJsonResponse(201, { ok: true, data: { published_package_id: 'p1' } });
  };

  const client = createServerApiClient();
  const result = await client.publishFromUploadedDraft('550e8400-e29b-41d4-a716-446655440000', {
    title: 'Published title',
    subject: 'Algebra',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(requestBody), {
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Published title',
    subject: 'Algebra',
  });
});

test('listPublishedPackages sends canonical query shape with title, subject, owner, limit, and offset', async () => {
  setTestWindow();
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return mockJsonResponse(200, { ok: true, data: { items: [] } });
  };

  const client = createServerApiClient();
  const result = await client.listPublishedPackages({ title: 'math', subject: 'algebra', owner: 'owner@example.test' });
  assert.equal(result.ok, true);
  assert.equal(
    requestedUrl,
    '/api/worksheet-launcher/v1/published?title=math&subject=algebra&owner=owner%40example.test&limit=20&offset=0'
  );
});

test('rewriteText returns success payload for non-empty result', async () => {
  setTestWindow();
  globalThis.fetch = async (url, request = {}) => {
    assert.equal(url, '/api/rewrite-bridge/rewrite');
    assert.equal(request.method, 'POST');
    assert.equal(request.credentials, 'include');
    assert.equal(request.headers?.['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { text: 'hello', stream: false });
    return mockJsonResponse(200, { ok: true, result: ' rewritten ' });
  };

  const client = createServerApiClient();
  const result = await client.rewriteText('hello');
  assert.equal(result.ok, true);
  assert.equal(result.data.text, 'rewritten');
});

test('rewriteText returns BRIDGE_EMPTY_RESPONSE for empty/missing/whitespace result', async () => {
  setTestWindow();
  const payloads = [
    { ok: true, result: '' },
    { ok: true, result: '   ' },
    { ok: true },
  ];
  let index = 0;
  globalThis.fetch = async () => mockJsonResponse(200, payloads[index++]);

  const client = createServerApiClient();
  for (let i = 0; i < payloads.length; i += 1) {
    const result = await client.rewriteText('hello');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'BRIDGE_EMPTY_RESPONSE');
  }
});

test('rewriteText maps auth statuses and auth-like html responses to AUTH_REQUIRED', async () => {
  setTestWindow();
  const responses = [
    mockJsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } }),
    mockJsonResponse(403, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'auth' } }),
    new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ];
  let index = 0;
  globalThis.fetch = async () => responses[index++];

  const client = createServerApiClient();
  for (let i = 0; i < responses.length; i += 1) {
    const result = await client.rewriteText('hello');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AUTH_REQUIRED');
    assert.equal(result.error.requiresSignIn, true);
  }
});

test('rewriteText preserves backend auth error payload for JSON 401 responses', async () => {
  setTestWindow();
  globalThis.fetch = async () => mockJsonResponse(401, {
    ok: false,
    error: {
      code: 'BRIDGE_AUTH_HEADER_MISSING',
      message: 'Missing X-Bridge-Auth header.',
      details: { expectedHeader: 'X-Bridge-Auth' },
    },
  });

  const client = createServerApiClient();
  const result = await client.rewriteText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BRIDGE_AUTH_HEADER_MISSING');
  assert.equal(result.error.message, 'Missing X-Bridge-Auth header.');
  assert.equal(result.error.status, 401);
  assert.equal(result.error.requiresSignIn, true);
  assert.deepEqual(result.error.details, { expectedHeader: 'X-Bridge-Auth' });
});

test('rewriteText returns NETWORK_ERROR on fetch failure', async () => {
  setTestWindow();
  globalThis.fetch = async () => {
    throw new Error('socket hang up');
  };

  const client = createServerApiClient();
  const result = await client.rewriteText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NETWORK_ERROR');
});

test('generateAudioFromText returns Uint8Array for audio/mpeg non-empty bytes', async () => {
  setTestWindow();
  globalThis.fetch = async (url, request = {}) => {
    assert.equal(url, '/api/rewrite-bridge/t2a');
    assert.equal(request.method, 'POST');
    assert.equal(request.credentials, 'include');
    assert.equal(request.headers?.['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), {
      text: 'hello',
      format: 'mp3',
      response_mode: 'binary',
    });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  const client = createServerApiClient();
  const result = await client.generateAudioFromText('hello');
  assert.equal(result.ok, true);
  assert.equal(result.data instanceof Uint8Array, true);
  assert.deepEqual(Array.from(result.data), [1, 2, 3]);
});

test('generateAudioFromText returns BRIDGE_EMPTY_RESPONSE for zero-byte payload', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response(new Uint8Array([]), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });

  const client = createServerApiClient();
  const result = await client.generateAudioFromText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BRIDGE_EMPTY_RESPONSE');
});

test('generateAudioFromText returns UNEXPECTED_CONTENT_TYPE when mime does not match', async () => {
  setTestWindow();
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2]), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });

  const client = createServerApiClient();
  const result = await client.generateAudioFromText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNEXPECTED_CONTENT_TYPE');
});

test('generateAudioFromText maps auth statuses and auth-like html responses to AUTH_REQUIRED', async () => {
  setTestWindow();
  const responses = [
    new Response('', { status: 401, headers: { 'content-type': 'audio/mpeg' } }),
    new Response('', { status: 403, headers: { 'content-type': 'audio/mpeg' } }),
    new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ];
  let index = 0;
  globalThis.fetch = async () => responses[index++];

  const client = createServerApiClient();
  for (let i = 0; i < responses.length; i += 1) {
    const result = await client.generateAudioFromText('hello');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AUTH_REQUIRED');
    assert.equal(result.error.requiresSignIn, true);
  }
});

test('generateAudioFromText returns NETWORK_ERROR on fetch failure', async () => {
  setTestWindow();
  globalThis.fetch = async () => {
    throw new Error('bridge unreachable');
  };

  const client = createServerApiClient();
  const result = await client.generateAudioFromText('hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NETWORK_ERROR');
});

test('bridge methods always use /api/rewrite-bridge urls regardless of apiBase override or query param', async () => {
  setTestWindow('?apiBase=%2Fapi%2Foverride-from-query');
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(url);
    if (url.endsWith('/rewrite')) {
      return mockJsonResponse(200, { ok: true, data: { text: 'rewritten' } });
    }
    return new Response(new Uint8Array([7]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  const client = createServerApiClient({ apiBase: '/api/override-from-options' });
  await client.rewriteText('hello');
  await client.generateAudioFromText('hello');

  assert.deepEqual(requestedUrls, [
    '/api/rewrite-bridge/rewrite',
    '/api/rewrite-bridge/t2a',
  ]);
  assert.equal(client.publicApiBase, '/api/override-from-options');
});
