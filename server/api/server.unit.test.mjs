import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createApiServer } from './server.js';

async function withServer({
  service = {},
  rolePlaySceneDraftService = {},
  artifactStore = {},
  nodeEnv = 'test',
  configOverrides = {},
}, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worksheet-server-test-'));
  const openSockets = new Set();
  const api = await createApiServer({
    config: {
      nodeEnv,
      storageRoot: tempDir,
      authHeaders: {
        sub: 'x-oidc-sub',
        email: 'x-oidc-email',
        name: 'x-oidc-name',
      },
      trustedProxy: {
        secret: null,
        secretHeader: 'x-worksheet-proxy-secret',
      },
      browsePageLimitDefault: 20,
      browsePageLimitMax: 100,
      draftSlotLimit: 3,
      attemptSlotLimit: 3,
      packageUploadMaxBytes: 31457280,
      ...configOverrides,
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
      async deleteOwnPublishedPackage() {
        return { ok: true, statusCode: 200, data: { published_package_id: 'x', deleted: true } };
      },
      ...service,
    },
    rolePlaySceneDraftService: {
      async uploadRolePlaySceneDraft() {
        return { ok: true, statusCode: 201, data: {} };
      },
      async listOwnRolePlaySceneDrafts() {
        return [];
      },
      async loadOwnRolePlaySceneDraftArtifact() {
        return null;
      },
      async deleteOwnRolePlaySceneDraft() {
        return {
          ok: true,
          statusCode: 200,
          data: { roleplayscene_uploaded_draft_id: 'x', deleted: true },
        };
      },
      async publishRolePlaySceneFromDraft() {
        return { ok: true, statusCode: 201, data: { roleplayscene_published_scene_id: 'p1' } };
      },
      async listPublishedRolePlaySceneScenes() {
        return { items: [], limit: 20, offset: 0, hasMore: false };
      },
      async loadPublishedRolePlaySceneScene() {
        return null;
      },
      async deleteOwnPublishedRolePlayScene() {
        return {
          ok: true,
          statusCode: 200,
          data: { roleplayscene_published_scene_id: 'p1', deleted: true },
        };
      },
      ...rolePlaySceneDraftService,
    },
    artifactStore: {
      async readArtifact() {
        return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      },
      ...artifactStore,
    },
  });

  api.server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => {
      openSockets.delete(socket);
    });
  });

  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const addr = api.server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await fn(baseUrl, tempDir);
  } finally {
    // Undici/fetch may keep sockets alive; force-close any remaining sockets
    // so server.close() resolves consistently across Node/OS environments.
    for (const socket of openSockets) {
      if (socket instanceof net.Socket && !socket.destroyed) {
        socket.destroy();
      }
    }
    await api.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const authHeaders = { 'x-oidc-sub': 'user-sub' };

test('GET /healthz remains unauthenticated', async () => {
  await withServer(
    {
      configOverrides: {
        trustedProxy: {
          secret: 'expected-secret',
          secretHeader: 'x-worksheet-proxy-secret',
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/healthz`);

      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.deepEqual(payload, { ok: true, data: { status: 'ok' } });
    }
  );
});

test('GET /api/v1/session rejects spoofed OIDC headers without proxy secret when configured', async () => {
  await withServer(
    {
      configOverrides: {
        trustedProxy: {
          secret: 'expected-secret',
          secretHeader: 'x-worksheet-proxy-secret',
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/session`, {
        headers: {
          'x-oidc-sub': 'spoofed-user',
        },
      });

      assert.equal(res.status, 401);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'AUTH_REQUIRED');
      assert.equal(payload.error.message, 'Missing or invalid trusted proxy secret.');
    }
  );
});

test('GET /api/v1/session rejects wrong proxy secret when configured', async () => {
  await withServer(
    {
      configOverrides: {
        trustedProxy: {
          secret: 'expected-secret',
          secretHeader: 'x-worksheet-proxy-secret',
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/session`, {
        headers: {
          ...authHeaders,
          'x-worksheet-proxy-secret': 'wrong-secret',
        },
      });

      assert.equal(res.status, 401);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'AUTH_REQUIRED');
    }
  );
});

test('GET /api/v1/session accepts Apache-shaped secret and OIDC headers', async () => {
  await withServer(
    {
      configOverrides: {
        trustedProxy: {
          secret: 'expected-secret',
          secretHeader: 'x-worksheet-proxy-secret',
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/session`, {
        headers: {
          ...authHeaders,
          'x-oidc-email': 'user@example.com',
          'x-worksheet-proxy-secret': 'expected-secret',
        },
      });

      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data.user, {
        sub: 'user-sub',
        email: 'user@example.com',
        name: null,
      });
    }
  );
});

test('POST /api/v1/drafts/upload forwards upload payload and returns success', async () => {
  let received = null;
  await withServer(
    {
      service: {
        async uploadDraft(payload) {
          received = payload;
          return { ok: true, statusCode: 201, data: { uploaded_draft_id: 'u1' } };
        },
      },
    },
    async (baseUrl) => {
      const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      const res = await fetch(`${baseUrl}/api/v1/drafts/upload?title=Title&subject=Math&conflictAction=replace`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/zip' },
        body: zipBytes,
      });
      assert.equal(res.status, 201);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.data.uploaded_draft_id, 'u1');
    }
  );

  assert.equal(received.title, 'Title');
  assert.equal(received.subject, 'Math');
  assert.equal(received.conflictAction, 'replace');
  assert.deepEqual(Array.from(received.zipBytes), [0x50, 0x4b, 0x03, 0x04]);
});

test('POST /api/v1/drafts/upload maps invalid package error to structured 400 payload', async () => {
  await withServer(
    {
      service: {
        async uploadDraft() {
          return {
            ok: false,
            statusCode: 400,
            error: {
              code: 'INVALID_WORKSHEET_PACKAGE',
              message: 'Uploaded worksheet package is invalid or corrupted.',
            },
          };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/drafts/upload`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/zip' },
        body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      });
      assert.equal(res.status, 400);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'INVALID_WORKSHEET_PACKAGE');
      assert.equal(payload.error.message, 'Uploaded worksheet package is invalid or corrupted.');
    }
  );
});

test('POST /api/v1/drafts/upload returns 413 with PACKAGE_UPLOAD_TOO_LARGE when body exceeds configured max', async () => {
  let uploadCalled = false;
  await withServer(
    {
      configOverrides: {
        packageUploadMaxBytes: 16,
      },
      service: {
        async uploadDraft() {
          uploadCalled = true;
          return { ok: true, statusCode: 201, data: {} };
        },
      },
    },
    async (baseUrl) => {
      const oversized = new Uint8Array(32);
      const res = await fetch(`${baseUrl}/api/v1/drafts/upload`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/zip' },
        body: oversized,
      });
      assert.equal(res.status, 413);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'PACKAGE_UPLOAD_TOO_LARGE');
      assert.equal(payload.error.message, 'Uploaded package is too large.');
    }
  );
  assert.equal(uploadCalled, false);
});

test('POST /api/v1/attempts/upload forwards payload and returns success', async () => {
  let received = null;
  await withServer(
    {
      service: {
        async uploadAttempt(payload) {
          received = payload;
          return { ok: true, statusCode: 201, data: { uploaded_attempt_id: 'a1' } };
        },
      },
    },
    async (baseUrl) => {
      const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      const res = await fetch(`${baseUrl}/api/v1/attempts/upload?title=Attempt&subject=Math&conflictAction=copy`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/zip' },
        body: zipBytes,
      });
      assert.equal(res.status, 201);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.data.uploaded_attempt_id, 'a1');
    }
  );

  assert.equal(received.title, 'Attempt');
  assert.equal(received.subject, 'Math');
  assert.equal(received.conflictAction, 'copy');
  assert.deepEqual(Array.from(received.zipBytes), [0x50, 0x4b, 0x03, 0x04]);
});

test('POST /api/v1/attempts/upload returns 413 with PACKAGE_UPLOAD_TOO_LARGE when body exceeds configured max', async () => {
  let uploadCalled = false;
  await withServer(
    {
      configOverrides: {
        packageUploadMaxBytes: 16,
      },
      service: {
        async uploadAttempt() {
          uploadCalled = true;
          return { ok: true, statusCode: 201, data: {} };
        },
      },
    },
    async (baseUrl) => {
      const oversized = new Uint8Array(32);
      const res = await fetch(`${baseUrl}/api/v1/attempts/upload`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/zip' },
        body: oversized,
      });
      assert.equal(res.status, 413);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'PACKAGE_UPLOAD_TOO_LARGE');
      assert.equal(payload.error.message, 'Uploaded package is too large.');
    }
  );
  assert.equal(uploadCalled, false);
});

test('DELETE /api/v1/attempts/:id/artifact returns 404 and does not delete attempt', async () => {
  let called = false;
  await withServer(
    {
      service: {
        async deleteOwnAttempt() {
          called = true;
          return { ok: true, statusCode: 200, data: { uploaded_attempt_id: 'x', deleted: true } };
        },
      },
    },
    async (baseUrl) => {
      const attemptId = '550e8400-e29b-41d4-a716-446655440000';
      const res = await fetch(`${baseUrl}/api/v1/attempts/${attemptId}/artifact`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(res.status, 404);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'NOT_FOUND');
    }
  );

  assert.equal(called, false);
});

test('GET /api/v1/attempts returns uploaded attempts list', async () => {
  let identitySub = null;
  await withServer(
    {
      service: {
        async listOwnAttempts(identity) {
          identitySub = identity.sub;
          return [{ uploaded_attempt_id: 'a1' }];
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/attempts`, {
        headers: authHeaders,
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data.items, [{ uploaded_attempt_id: 'a1' }]);
      assert.equal(payload.data.attemptSlotLimit, 3);
    }
  );
  assert.equal(identitySub, 'user-sub');
});

test('GET /api/v1/drafts returns uploaded drafts list with draft slot limit', async () => {
  await withServer(
    {
      service: {
        async listOwnDrafts() {
          return [{ uploaded_draft_id: 'd1' }];
        },
      },
      configOverrides: {
        draftSlotLimit: 5,
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/drafts`, {
        headers: authHeaders,
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data.items, [{ uploaded_draft_id: 'd1' }]);
      assert.equal(payload.data.draftSlotLimit, 5);
    }
  );
});

test('POST /api/v1/roleplayscene/drafts/upload requires application/zip', async () => {
  let uploadCalled = false;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async uploadRolePlaySceneDraft() {
          uploadCalled = true;
          return { ok: true, statusCode: 201, data: {} };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/drafts/upload`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 415);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    }
  );
  assert.equal(uploadCalled, false);
});

test('POST /api/v1/roleplayscene/drafts/upload forwards title description conflictAction', async () => {
  let received = null;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async uploadRolePlaySceneDraft(payload) {
          received = payload;
          return {
            ok: true,
            statusCode: 201,
            data: { roleplayscene_uploaded_draft_id: 'r1', warnings: [] },
          };
        },
      },
    },
    async (baseUrl) => {
      const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      const res = await fetch(
        `${baseUrl}/api/v1/roleplayscene/drafts/upload?title=Clinic&description=Draft&conflictAction=copy`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/zip' },
          body: zipBytes,
        }
      );
      assert.equal(res.status, 201);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.data.roleplayscene_uploaded_draft_id, 'r1');
    }
  );

  assert.equal(received.title, 'Clinic');
  assert.equal(received.description, 'Draft');
  assert.equal(received.conflictAction, 'copy');
  assert.deepEqual(Array.from(received.zipBytes), [0x50, 0x4b, 0x03, 0x04]);
});

test('POST /api/v1/roleplayscene/drafts/upload maps validator errors to 400', async () => {
  await withServer(
    {
      rolePlaySceneDraftService: {
        async uploadRolePlaySceneDraft() {
          return {
            ok: false,
            statusCode: 400,
            error: {
              code: 'INVALID_ROLEPLAYSCENE_PROJECT_JSON',
              message: 'Uploaded RolePlayScene project JSON is invalid.',
              details: { reason: 'bad json' },
            },
          };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/drafts/upload`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/zip' },
        body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      });
      assert.equal(res.status, 400);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'INVALID_ROLEPLAYSCENE_PROJECT_JSON');
      assert.deepEqual(payload.error.details, { reason: 'bad json' });
    }
  );
});

test('GET /api/v1/roleplayscene/drafts returns items and draft slot limit', async () => {
  let identitySub = null;
  await withServer(
    {
      configOverrides: { draftSlotLimit: 5 },
      rolePlaySceneDraftService: {
        async listOwnRolePlaySceneDrafts(identity) {
          identitySub = identity.sub;
          return [{ roleplayscene_uploaded_draft_id: 'r1', title: 'Clinic' }];
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/drafts`, { headers: authHeaders });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data.items, [{ roleplayscene_uploaded_draft_id: 'r1', title: 'Clinic' }]);
      assert.equal(payload.data.draftSlotLimit, 5);
    }
  );
  assert.equal(identitySub, 'user-sub');
});

test('GET /api/v1/roleplayscene/drafts/:id/artifact validates UUID and returns ZIP bytes', async () => {
  await withServer({}, async (baseUrl) => {
    const badRes = await fetch(`${baseUrl}/api/v1/roleplayscene/drafts/not-a-uuid/artifact`, {
      headers: authHeaders,
    });
    assert.equal(badRes.status, 400);
    const badPayload = await badRes.json();
    assert.equal(badPayload.error.code, 'INVALID_ROLEPLAYSCENE_UPLOADED_DRAFT_ID');
  });

  await withServer(
    {
      rolePlaySceneDraftService: {
        async loadOwnRolePlaySceneDraftArtifact({ uploadedDraftId }) {
          assert.equal(uploadedDraftId, '550e8400-e29b-41d4-a716-446655440000');
          return { artifact_path: 'roleplayscene/drafts/user-sub/abc.zip' };
        },
      },
      artifactStore: {
        async readArtifact(artifactPath) {
          assert.equal(artifactPath, 'roleplayscene/drafts/user-sub/abc.zip');
          return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/v1/roleplayscene/drafts/550e8400-e29b-41d4-a716-446655440000/artifact`,
        { headers: authHeaders }
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      assert.equal(res.headers.get('content-disposition'), 'attachment; filename="roleplayscene-draft.zip"');
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(Array.from(bytes), [0x50, 0x4b, 0x03, 0x04]);
    }
  );
});

test('DELETE /api/v1/roleplayscene/drafts/:id validates UUID and returns delete payload', async () => {
  await withServer({}, async (baseUrl) => {
    const badRes = await fetch(`${baseUrl}/api/v1/roleplayscene/drafts/not-a-uuid`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    assert.equal(badRes.status, 400);
    const badPayload = await badRes.json();
    assert.equal(badPayload.error.code, 'INVALID_ROLEPLAYSCENE_UPLOADED_DRAFT_ID');
  });

  let received = null;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async deleteOwnRolePlaySceneDraft(payload) {
          received = payload;
          return {
            ok: true,
            statusCode: 200,
            data: {
              roleplayscene_uploaded_draft_id: payload.uploadedDraftId,
              deleted: true,
            },
          };
        },
      },
    },
    async (baseUrl) => {
      const draftId = '550e8400-e29b-41d4-a716-446655440000';
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/drafts/${draftId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.deepEqual(payload.data, {
        roleplayscene_uploaded_draft_id: draftId,
        deleted: true,
      });
    }
  );

  assert.deepEqual(received, {
    identity: { sub: 'user-sub', email: null, name: null },
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
  });
});

test('roleplayscene routes do not affect existing worksheet draft route namespace', async () => {
  let worksheetCalled = false;
  let roleplayCalled = false;
  await withServer(
    {
      service: {
        async listOwnDrafts() {
          worksheetCalled = true;
          return [{ uploaded_draft_id: 'worksheet-draft' }];
        },
      },
      rolePlaySceneDraftService: {
        async listOwnRolePlaySceneDrafts() {
          roleplayCalled = true;
          return [{ roleplayscene_uploaded_draft_id: 'roleplay-draft' }];
        },
      },
    },
    async (baseUrl) => {
      const worksheetRes = await fetch(`${baseUrl}/api/v1/drafts`, { headers: authHeaders });
      const worksheetPayload = await worksheetRes.json();
      assert.deepEqual(worksheetPayload.data.items, [{ uploaded_draft_id: 'worksheet-draft' }]);

      const roleplayRes = await fetch(`${baseUrl}/api/v1/roleplayscene/drafts`, { headers: authHeaders });
      const roleplayPayload = await roleplayRes.json();
      assert.deepEqual(roleplayPayload.data.items, [{ roleplayscene_uploaded_draft_id: 'roleplay-draft' }]);
    }
  );

  assert.equal(worksheetCalled, true);
  assert.equal(roleplayCalled, true);
});

test('POST /api/v1/roleplayscene/published rejects malformed uploadedDraftId with 400', async () => {
  let publishCalled = false;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async publishRolePlaySceneFromDraft() {
          publishCalled = true;
          return { ok: true, statusCode: 201, data: {} };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ uploadedDraftId: 'not-a-uuid' }),
      });
      assert.equal(res.status, 400);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'INVALID_ROLEPLAYSCENE_UPLOADED_DRAFT_ID');
    }
  );
  assert.equal(publishCalled, false);
});

for (const [name, metadata] of [
  ['omitted', {}],
  ['provided', { description: 'Practice ordering food.' }],
  ['cleared', { description: '' }],
]) {
  test(`RolePlayScene publish forwards ${name} description`, async () => {
    let received = null;
    await withServer(
      {
        rolePlaySceneDraftService: {
          async publishRolePlaySceneFromDraft(payload) {
            received = payload;
            return {
              ok: true,
              statusCode: 201,
              data: { roleplayscene_published_scene_id: 'p1', title: payload.title },
            };
          },
        },
      },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({
            uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
            title: 'Published Clinic',
            ...metadata,
          }),
        });
        assert.equal(res.status, 201);
        const payload = await res.json();
        assert.equal(payload.ok, true);
        assert.deepEqual(payload.data, { roleplayscene_published_scene_id: 'p1', title: 'Published Clinic' });
      }
    );

    assert.deepEqual(received, {
      identity: { sub: 'user-sub', email: null, name: null },
      uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Published Clinic',
      ...metadata,
    });
  });

}

test('POST /api/v1/roleplayscene/published maps service errors with details', async () => {
  await withServer(
    {
      rolePlaySceneDraftService: {
        async publishRolePlaySceneFromDraft() {
          return {
            ok: false,
            statusCode: 409,
            error: {
              code: 'ROLEPLAYSCENE_PUBLISHED_TITLE_CONFLICT',
              message: 'A published RolePlayScene with this title already exists.',
              details: { requestedTitle: 'Published Clinic' },
            },
          };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
          title: 'Published Clinic',
        }),
      });
      assert.equal(res.status, 409);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'ROLEPLAYSCENE_PUBLISHED_TITLE_CONFLICT');
      assert.deepEqual(payload.error.details, { requestedTitle: 'Published Clinic' });
    }
  );
});

test('GET /api/v1/roleplayscene/published forwards filters and pagination', async () => {
  let received = null;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async listPublishedRolePlaySceneScenes(payload) {
          received = payload;
          return {
            items: [{ roleplayscene_published_scene_id: 'p1', title: 'Clinic' }],
            limit: payload.limit,
            offset: payload.offset,
            hasMore: false,
          };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published?q=clinic&title=Greeting&description=Practice&owner=teacher&limit=12&offset=24`, {
        headers: authHeaders,
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data.items, [{ roleplayscene_published_scene_id: 'p1', title: 'Clinic' }]);
    }
  );
  assert.deepEqual(received, {
    query: 'clinic',
    title: 'Greeting',
    description: 'Practice',
    owner: 'teacher',
    limit: 12,
    offset: 24,
  });
});

test('GET /api/v1/roleplayscene/published/:id rejects malformed ids', async () => {
  let loadCalled = false;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async loadPublishedRolePlaySceneScene() {
          loadCalled = true;
          return null;
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published/not-a-uuid`, { headers: authHeaders });
      assert.equal(res.status, 400);
      const payload = await res.json();
      assert.equal(payload.error.code, 'INVALID_ROLEPLAYSCENE_PUBLISHED_SCENE_ID');
    }
  );
  assert.equal(loadCalled, false);
});

test('GET /api/v1/roleplayscene/published/:id returns metadata without owner scope', async () => {
  let receivedId = null;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async loadPublishedRolePlaySceneScene(publishedSceneId) {
          receivedId = publishedSceneId;
          return {
            roleplayscene_published_scene_id: publishedSceneId,
            owner_sub: 'other-owner',
            title: 'Clinic',
            artifact_path: 'roleplayscene/published/p1.zip',
            artifact_sha256: 'sha',
            artifact_size_bytes: 4,
            published_at: '2026-05-14T00:00:00.000Z',
          };
        },
      },
    },
    async (baseUrl) => {
      const id = '550e8400-e29b-41d4-a716-446655440000';
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published/${id}`, { headers: authHeaders });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.data.owner_sub, 'other-owner');
      assert.equal(payload.data.artifact_path, undefined);
    }
  );
  assert.equal(receivedId, '550e8400-e29b-41d4-a716-446655440000');
});

test('GET /api/v1/roleplayscene/published/:id returns 404 for missing published scene', async () => {
  await withServer(
    {
      rolePlaySceneDraftService: {
        async loadPublishedRolePlaySceneScene() {
          return null;
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published/550e8400-e29b-41d4-a716-446655440000`, {
        headers: authHeaders,
      });
      assert.equal(res.status, 404);
      const payload = await res.json();
      assert.equal(payload.error.code, 'ROLEPLAYSCENE_PUBLISHED_SCENE_NOT_FOUND');
    }
  );
});

test('GET /api/v1/roleplayscene/published/:id/artifact returns exact zip bytes', async () => {
  let artifactPath = null;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async loadPublishedRolePlaySceneScene() {
          return { artifact_path: 'roleplayscene/published/p1.zip' };
        },
      },
      artifactStore: {
        async readArtifact(pathValue) {
          artifactPath = pathValue;
          return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published/550e8400-e29b-41d4-a716-446655440000/artifact`, {
        headers: authHeaders,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      assert.deepEqual(Array.from(new Uint8Array(await res.arrayBuffer())), [0x50, 0x4b, 0x03, 0x04]);
    }
  );
  assert.equal(artifactPath, 'roleplayscene/published/p1.zip');
});

test('DELETE /api/v1/roleplayscene/published/:id rejects malformed ids', async () => {
  let deleteCalled = false;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async deleteOwnPublishedRolePlayScene() {
          deleteCalled = true;
          return { ok: true, statusCode: 200, data: {} };
        },
      },
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published/not-a-uuid`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(res.status, 400);
      const payload = await res.json();
      assert.equal(payload.error.code, 'INVALID_ROLEPLAYSCENE_PUBLISHED_SCENE_ID');
    }
  );
  assert.equal(deleteCalled, false);
});

test('DELETE /api/v1/roleplayscene/published/:id forwards owner-scoped delete', async () => {
  let received = null;
  await withServer(
    {
      rolePlaySceneDraftService: {
        async deleteOwnPublishedRolePlayScene(payload) {
          received = payload;
          return {
            ok: true,
            statusCode: 200,
            data: { roleplayscene_published_scene_id: payload.publishedSceneId, deleted: true },
          };
        },
      },
    },
    async (baseUrl) => {
      const id = '550e8400-e29b-41d4-a716-446655440000';
      const res = await fetch(`${baseUrl}/api/v1/roleplayscene/published/${id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data, { roleplayscene_published_scene_id: id, deleted: true });
    }
  );
  assert.deepEqual(received, {
    identity: { sub: 'user-sub', email: null, name: null },
    publishedSceneId: '550e8400-e29b-41d4-a716-446655440000',
  });
});

test('POST /api/v1/published returns 413 with REQUEST_BODY_TOO_LARGE when body exceeds configured max', async () => {
  let publishCalled = false;
  await withServer(
    {
      configOverrides: {
        packageUploadMaxBytes: 16,
      },
      service: {
        async publishFromDraft() {
          publishCalled = true;
          return { ok: true, statusCode: 201, data: {} };
        },
      },
    },
    async (baseUrl) => {
      const oversizedPayload = JSON.stringify({
        uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
        x: 'a'.repeat((31 * 1024 * 1024) + 128),
      });
      const res = await fetch(`${baseUrl}/api/v1/published`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': 'application/json',
        },
        body: oversizedPayload,
      });

      assert.equal(res.status, 413);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'REQUEST_BODY_TOO_LARGE');
      assert.equal(payload.error.message, 'Request body is too large.');
    }
  );

  assert.equal(publishCalled, false);
});

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

test('DELETE /api/v1/published/:id rejects malformed publishedPackageId with 400', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/published/not-a-uuid`, {
      method: 'DELETE',
      headers: authHeaders,
    });

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_PUBLISHED_PACKAGE_ID');
  });
});

test('DELETE /api/v1/published/:id forwards owner-scoped delete and returns payload', async () => {
  let received = null;
  await withServer(
    {
      service: {
        async deleteOwnPublishedPackage({ identity, publishedPackageId }) {
          received = { identity, publishedPackageId };
          return {
            ok: true,
            statusCode: 200,
            data: { published_package_id: publishedPackageId, deleted: true },
          };
        },
      },
    },
    async (baseUrl) => {
      const publishedPackageId = '550e8400-e29b-41d4-a716-446655440000';
      const res = await fetch(`${baseUrl}/api/v1/published/${publishedPackageId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.data, { published_package_id: publishedPackageId, deleted: true });
    }
  );

  assert.deepEqual(received, {
    identity: { sub: 'user-sub', email: null, name: null },
    publishedPackageId: '550e8400-e29b-41d4-a716-446655440000',
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

test('GET /api/v1/published rejects zero limit query with 400', async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/published?limit=0`, {
      headers: authHeaders,
    });

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_QUERY_PARAM');
  });
});

test('GET /api/v1/published forwards q/title/subject/owner filters (owner email value)', async () => {
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
        `${baseUrl}/api/v1/published?q=fractions&title=Algebra&subject=Math&owner=teacher%40example.com&limit=5&offset=2`,
        { headers: authHeaders }
      );
      assert.equal(res.status, 200);
    }
  );

  assert.deepEqual(received, {
    query: 'fractions',
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
