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
