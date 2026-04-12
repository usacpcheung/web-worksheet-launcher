import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApiServer } from './server.js';

async function withServer({ service = {}, artifactStore = {}, nodeEnv = 'test' }, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worksheet-server-test-'));
  const api = await createApiServer({
    config: {
      nodeEnv,
      storageRoot: tempDir,
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
      async loadOwnDraftArtifact() {
        return null;
      },
      async deleteOwnDraft() {
        return { ok: true, statusCode: 200, data: { uploaded_draft_id: 'x', deleted: true } };
      },
      async loadPublishedPackage() {
        return null;
      },
      async listPublished() {
        return { items: [], limit: 20, offset: 0, hasMore: false };
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
    await fn(baseUrl, tempDir);
  } finally {
    await api.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const authHeaders = { 'x-oidc-sub': 'user-sub' };

test('GET /api/v1/session returns ready identity payload', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/session`, {
      headers: {
        ...authHeaders,
        'x-oidc-email': 'user@example.com',
        'x-oidc-name': 'User Name',
      },
    });

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.data, {
      ready: true,
      user: {
        sub: 'user-sub',
        email: 'user@example.com',
        name: 'User Name',
      },
    });
  });
});

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

test('POST /api/v1/published forwards title/subject overrides', async () => {
  let received = null;
  await withServer(
    {
      service: {
        async publishFromDraft(payload) {
          received = payload;
          return { ok: true, statusCode: 201, data: { published_package_id: 'p1' } };
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
        body: JSON.stringify({
          uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
          title: 'Release worksheet',
          subject: 'Geometry',
        }),
      });
      assert.equal(res.status, 201);
    }
  );

  assert.deepEqual(received, {
    identity: { sub: 'user-sub', email: null, name: null },
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Release worksheet',
    subject: 'Geometry',
  });
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

test('GET /api/v1/published forwards title/subject/owner filters (owner email value)', async () => {
  let received = null;
  await withServer(
    {
      service: {
        async listPublished(filters) {
          received = filters;
          return { items: [], limit: 5, offset: 2, hasMore: false };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/v1/published?title=Algebra&subject=Math&owner=teacher%40example.com&limit=5&offset=2`,
        { headers: authHeaders }
      );
      assert.equal(res.status, 200);
    }
  );

  assert.deepEqual(received, {
    title: 'Algebra',
    subject: 'Math',
    owner: 'teacher@example.com',
    limit: 5,
    offset: 2,
  });
});

test('GET /api/v1/published returns pagination metadata payload', async () => {
  await withServer(
    {
      service: {
        async listPublished() {
          return {
            items: [{ published_package_id: 'p1', title: 'Pack 1' }],
            limit: 1,
            offset: 0,
            hasMore: true,
            nextOffset: 1,
          };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/published?limit=1&offset=0`, { headers: authHeaders });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data, {
        items: [{ published_package_id: 'p1', title: 'Pack 1' }],
        limit: 1,
        offset: 0,
        hasMore: true,
        nextOffset: 1,
      });
    }
  );
});

test('GET /api/v1/drafts/:id/artifact rejects malformed uploadedDraftId with 400', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/drafts/not-a-uuid/artifact`, {
      headers: authHeaders,
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_UPLOADED_DRAFT_ID');
  });
});

test('GET /api/v1/drafts/:id/artifact returns ZIP bytes for owner draft', async () => {
  await withServer(
    {
      service: {
        async loadOwnDraftArtifact() {
          return { artifact_path: 'drafts/user-sub/abc.zip' };
        },
      },
      artifactStore: {
        async readArtifact(artifactPath) {
          assert.equal(artifactPath, 'drafts/user-sub/abc.zip');
          return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/drafts/550e8400-e29b-41d4-a716-446655440000/artifact`, {
        headers: authHeaders,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(Array.from(bytes), [0x50, 0x4b, 0x03, 0x04]);
    }
  );
});

test('DELETE /api/v1/drafts/:id rejects malformed uploadedDraftId with 400', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/drafts/not-a-uuid`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_UPLOADED_DRAFT_ID');
  });
});

test('DELETE /api/v1/drafts/:id forwards owner-scoped delete and returns payload', async () => {
  let received = null;
  await withServer(
    {
      service: {
        async deleteOwnDraft({ identity, uploadedDraftId }) {
          received = { identity, uploadedDraftId };
          return {
            ok: true,
            statusCode: 200,
            data: { uploaded_draft_id: uploadedDraftId, deleted: true },
          };
        },
      },
    },
    async (baseUrl) => {
      const uploadedDraftId = '550e8400-e29b-41d4-a716-446655440000';
      const res = await fetch(`${baseUrl}/api/v1/drafts/${uploadedDraftId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data, { uploaded_draft_id: uploadedDraftId, deleted: true });
    }
  );

  assert.deepEqual(received, {
    identity: { sub: 'user-sub', email: null, name: null },
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
  });
});

test('DELETE /api/v1/drafts/:id returns owner-scoped not found from service', async () => {
  await withServer(
    {
      service: {
        async deleteOwnDraft() {
          return {
            ok: false,
            statusCode: 404,
            error: { code: 'UPLOADED_DRAFT_NOT_FOUND', message: 'Uploaded draft was not found for this owner.' },
          };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/drafts/550e8400-e29b-41d4-a716-446655440000`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(res.status, 404);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'UPLOADED_DRAFT_NOT_FOUND');
    }
  );
});

test('GET /api/v1/published/:id/extra returns 404 for unknown subroute', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/published/550e8400-e29b-41d4-a716-446655440000/extra`, {
      headers: authHeaders,
    });

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'NOT_FOUND');
  });
});

test('INTERNAL_ERROR hides sensitive message outside development', async () => {
  await withServer(
    {
      service: {
        async listOwnDrafts() {
          throw new Error('sensitive-db-details');
        },
      },
      nodeEnv: 'production',
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/drafts`, {
        headers: authHeaders,
      });

      assert.equal(res.status, 500);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'INTERNAL_ERROR');
      assert.equal(payload.error.message, 'Unexpected server error.');
    }
  );
});
