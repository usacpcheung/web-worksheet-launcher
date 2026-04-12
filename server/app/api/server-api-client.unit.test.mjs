import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerApiClient } from './server-api-client.js';

function mockJsonResponse(status, payload, headers = { 'content-type': 'application/json; charset=utf-8' }) {
  return new Response(JSON.stringify(payload), { status, headers });
}

test('createServerApiClient uses production public base path by default', async () => {
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search: '',
    },
  };
  globalThis.fetch = async () => mockJsonResponse(200, { ok: true, data: { ready: true } });

  const client = createServerApiClient();
  assert.equal(client.publicApiBase, '/api/worksheet-launcher/v1');
  await client.getSession();
});

test('getSession builds canonical public API URL', async () => {
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search: '',
    },
  };
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
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search: '',
    },
  };

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
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search: '',
    },
  };
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
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search: '',
    },
  };
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
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search: '',
    },
  };
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
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search: '',
    },
  };
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
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search: '',
    },
  };
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
  globalThis.window = {
    location: {
      origin: 'https://example.test',
      search: '',
    },
  };
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
