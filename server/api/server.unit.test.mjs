import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from './server.js';

async function withServer({ service = {}, artifactStore = {} }, fn) {
  const api = await createApiServer({
    config: {
      storageRoot: './var/test-package-storage',
      authHeaders: {
        sub: 'x-oidc-sub',
        email: 'x-oidc-email',
        name: 'x-oidc-name',
      },
      browsePageLimitDefault: 20,
      browsePageLimitMax: 100,
    },
    db: { async end() {} },
    service: {
      async uploadDraft() {
        return { ok: true, statusCode: 201, data: {} };
      },
      async listOwnDrafts() {
        return [];
      },
      async publishFromDraft() {
        return { ok: true, statusCode: 201, data: {} };
      },
      async loadPublishedPackage() {
        return null;
      },
      async listPublished() {
        return [];
      },
      ...service,
    },
    artifactStore: {
      async readArtifact() {
        return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      },
      ...artifactStore,
    },
  });

  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const addr = api.server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await api.close();
  }
}

const authHeaders = { 'x-oidc-sub': 'user-sub' };

test('POST /api/v1/published rejects malformed uploadedDraftId with 400', async () => {
  let called = false;
  await withServer(
    {
      service: {
        async publishFromDraft() {
          called = true;
          return { ok: true, statusCode: 201, data: {} };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/published`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ uploadedDraftId: 'not-a-uuid' }),
      });

      assert.equal(res.status, 400);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'INVALID_UPLOADED_DRAFT_ID');
    }
  );

  assert.equal(called, false);
});

test('GET /api/v1/published/:id rejects malformed publishedPackageId with 400', async () => {
  let called = false;
  await withServer(
    {
      service: {
        async loadPublishedPackage() {
          called = true;
          return null;
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/published/not-a-uuid`, {
        headers: authHeaders,
      });

      assert.equal(res.status, 400);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'INVALID_PUBLISHED_PACKAGE_ID');
    }
  );

  assert.equal(called, false);
});

test('GET /api/v1/published/:id/artifact rejects malformed publishedPackageId with 400', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/published/not-a-uuid/artifact`, {
      headers: authHeaders,
    });

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_PUBLISHED_PACKAGE_ID');
  });
});


test('GET /api/v1/published rejects invalid limit query with 400', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/published?limit=abc`, {
      headers: authHeaders,
    });

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_QUERY_PARAM');
  });
});
