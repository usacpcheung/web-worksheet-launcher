import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RolePlaySceneDraftService } from './roleplayscene-draft-service.js';
import { validateRolePlayScenePackage } from './roleplayscene-package.js';
import { createStoredZip } from '../../editor/zip-utils.js';

const identity = {
  sub: 'oidc-sub',
  email: 'teacher@example.test',
  name: 'Teacher',
};

function createProject(overrides = {}) {
  return {
    meta: { title: 'Clinic Practice', description: 'Draft conversation practice.' },
    scenes: [
      {
        id: 'scene-start',
        type: 'start',
        image: { name: 'cover.png', type: 'image/png', size: 5, path: 'media/scene-start/image.png' },
        backgroundAudio: null,
        dialogue: [
          {
            text: 'Hello',
            audio: { name: 'line.mp3', type: 'audio/mpeg', size: 5, path: 'media/scene-start/dialogue-1.mp3' },
          },
        ],
        choices: [],
      },
    ],
    assets: [],
    ...overrides,
  };
}

function createManifest(overrides = {}) {
  return {
    format: 'roleplayscene-package',
    packageVersion: 1,
    project: { title: 'Clinic Practice', version: 1 },
    assets: [
      { path: 'media/scene-start/image.png', kind: 'image', usage: 'scene_image', byteLength: 5 },
      { path: 'media/scene-start/dialogue-1.mp3', kind: 'audio', usage: 'dialogue_audio', byteLength: 5 },
    ],
    ...overrides,
  };
}

function createRolePlaySceneZip({
  manifest = createManifest(),
  project = createProject(),
  mediaEntries = {
    'media/scene-start/image.png': 'image',
    'media/scene-start/dialogue-1.mp3': 'audio',
  },
} = {}) {
  return createStoredZip([
    { path: 'manifest.json', data: JSON.stringify(manifest) },
    { path: 'content/project.json', data: JSON.stringify(project) },
    ...Object.entries(mediaEntries).map(([entryPath, data]) => ({ path: entryPath, data })),
  ]);
}

function createFakeDb({
  draftCount = 0,
  listRows = [],
  conflictRow = null,
  conflictTitles = ['clinic practice'],
  failInsert = false,
  deleteRowCount = 1,
  replaceUpdateRowCount = 1,
} = {}) {
  const state = { queries: [], values: [] };
  const db = {
    state,
    async query(sql, values = []) {
      return query(sql, values);
    },
    async connect() {
      return {
        async query(sql, values = []) {
          return query(sql, values);
        },
        release() {},
      };
    },
  };

  async function query(sql, values = []) {
    state.queries.push(sql);
    state.values.push(values);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT pg_advisory_xact_lock(hashtext($1))')) {
      return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 };
    }
    if (sql.includes('COUNT(*)::int AS count FROM roleplayscene_uploaded_drafts')) {
      return { rows: [{ count: draftCount }], rowCount: 1 };
    }
    if (
      sql.includes('FROM roleplayscene_uploaded_drafts')
      && sql.includes('ORDER BY created_at DESC')
      && !sql.includes('LIMIT 1')
    ) {
      return { rows: listRows, rowCount: listRows.length };
    }
    if (sql.includes('FROM roleplayscene_uploaded_drafts') && sql.includes('LIMIT 1')) {
      if (conflictRow && conflictTitles.includes(values[1])) {
        return { rows: [conflictRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO roleplayscene_uploaded_drafts')) {
      if (failInsert) throw new Error('insert failed');
      return {
        rows: [
          {
            roleplayscene_uploaded_draft_id: values[0],
            owner_sub: values[1],
            owner_email: values[2],
            owner_name: values[3],
            title: values[4],
            description: values[5],
            package_version: values[6],
            artifact_sha256: values[8],
            artifact_size_bytes: values[9],
            scene_count: values[10],
            media_count: values[11],
            missing_media_count: values[12],
            validation_warning_count: values[13],
            last_published_artifact_sha256: null,
            last_published_at: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('UPDATE roleplayscene_uploaded_drafts')) {
      if (replaceUpdateRowCount === 0) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            roleplayscene_uploaded_draft_id: values[0],
            owner_sub: values[1],
            owner_email: values[2],
            owner_name: values[3],
            title: values[4],
            description: values[5],
            package_version: values[6],
            artifact_sha256: values[8],
            artifact_size_bytes: values[9],
            scene_count: values[10],
            media_count: values[11],
            missing_media_count: values[12],
            validation_warning_count: values[13],
            last_published_artifact_sha256: conflictRow?.last_published_artifact_sha256 || null,
            last_published_at: conflictRow?.last_published_at || null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('DELETE FROM roleplayscene_uploaded_drafts')) {
      if (deleteRowCount === 0) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            roleplayscene_uploaded_draft_id: values[0],
            artifact_path: conflictRow?.artifact_path || 'roleplayscene/drafts/old.zip',
          },
        ],
        rowCount: 1,
      };
    }
    if (
      sql.includes('SELECT roleplayscene_uploaded_draft_id')
      && sql.includes('artifact_path')
      && !sql.includes('ORDER BY')
    ) {
      if (deleteRowCount === 0) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{ roleplayscene_uploaded_draft_id: values[0], owner_sub: values[1], artifact_path: 'roleplayscene/drafts/a.zip' }],
        rowCount: 1,
      };
    }
    throw new Error(`Unhandled RolePlayScene draft test query: ${sql}`);
  }

  return db;
}

function createService({ db, artifactStore }) {
  return new RolePlaySceneDraftService({
    db,
    artifactStore,
    config: { draftSlotLimit: 3 },
  });
}

function createConflictRow(overrides = {}) {
  return {
    roleplayscene_uploaded_draft_id: 'old-r',
    owner_sub: 'oidc-sub',
    title: 'Clinic Practice',
    description: 'Old',
    package_version: 1,
    artifact_path: 'roleplayscene/drafts/old.zip',
    artifact_sha256: 'sha-old',
    artifact_size_bytes: 4,
    scene_count: 1,
    media_count: 2,
    missing_media_count: 0,
    validation_warning_count: 0,
    last_published_artifact_sha256: null,
    last_published_at: null,
    ...overrides,
  };
}

test('uploadRolePlaySceneDraft creates row and stores artifact in roleplayscene drafts bucket', async () => {
  const db = createFakeDb();
  let stored = null;
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact(input) {
        stored = input;
        return {
          artifactPath: 'roleplayscene/drafts/oidc-sub/new.zip',
          absolutePath: '/tmp/new.zip',
          artifactSha256: 'sha-new',
          artifactSizeBytes: input.bytes.length,
        };
      },
    },
  });

  const result = await service.uploadRolePlaySceneDraft({
    identity,
    title: '',
    description: '',
    zipBytes: createRolePlaySceneZip(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 201);
  assert.equal(result.data.title, 'Clinic Practice');
  assert.equal(result.data.description, 'Draft conversation practice.');
  assert.equal(result.data.package_version, 1);
  assert.equal(result.data.scene_count, 1);
  assert.equal(result.data.media_count, 2);
  assert.equal(result.data.publish_state, 'draft_only');
  assert.deepEqual(result.data.warnings, []);
  assert.equal(stored.ownerSub, 'oidc-sub');
  assert.equal(stored.bucket, 'roleplayscene/drafts');
});

test('uploadRolePlaySceneDraft rejects invalid packages before DB and artifact writes', async () => {
  const db = createFakeDb();
  let artifactCalled = false;
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact() {
        artifactCalled = true;
        throw new Error('storeArtifact should not run');
      },
    },
  });

  const result = await service.uploadRolePlaySceneDraft({
    identity,
    title: 'Bad',
    description: '',
    zipBytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.error.code, 'INVALID_ROLEPLAYSCENE_PACKAGE_ZIP');
  assert.equal(artifactCalled, false);
  assert.equal(db.state.queries.length, 0);
});

test('uploadRolePlaySceneDraft default conflict returns ROLEPLAYSCENE_DRAFT_NAME_CONFLICT', async () => {
  const db = createFakeDb({
    draftCount: 1,
    conflictRow: createConflictRow(),
    listRows: [{ roleplayscene_uploaded_draft_id: 'old-r', title: 'Clinic Practice' }],
  });
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact() {
        throw new Error('storeArtifact should not run on conflict');
      },
    },
  });

  const result = await service.uploadRolePlaySceneDraft({
    identity,
    title: ' Clinic   Practice ',
    description: '',
    zipBytes: createRolePlaySceneZip(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error.code, 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT');
  assert.equal(result.error.details.existingDraft.roleplayscene_uploaded_draft_id, 'old-r');
  assert.equal(result.error.details.existingDraft.artifact_path, undefined);
  assert.equal(result.error.details.existingDraft.publish_state, 'draft_only');
  assert.deepEqual(result.error.details.uploadedDrafts, [{ roleplayscene_uploaded_draft_id: 'old-r', title: 'Clinic Practice' }]);
});

test('uploadRolePlaySceneDraft copy stores artifact with server-selected copy title inside package', async () => {
  let storedBytes = null;
  const zipBytes = createRolePlaySceneZip();
  const db = createFakeDb({
    draftCount: 1,
    conflictRow: createConflictRow(),
    conflictTitles: ['clinic practice', 'clinic practice (2)'],
  });
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact({ bytes }) {
        storedBytes = bytes;
        return {
          artifactPath: 'roleplayscene/drafts/copy.zip',
          absolutePath: '/tmp/copy.zip',
          artifactSha256: 'sha-copy',
          artifactSizeBytes: bytes.length,
        };
      },
    },
  });

  const result = await service.uploadRolePlaySceneDraft({
    identity,
    title: 'Clinic Practice',
    description: 'Draft',
    zipBytes,
    conflictAction: 'copy',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.title, 'Clinic Practice (3)');
  assert.notEqual(storedBytes, zipBytes);
  const storedValidation = validateRolePlayScenePackage(storedBytes);
  assert.equal(storedValidation.ok, true);
  assert.equal(storedValidation.metadata.title, 'Clinic Practice (3)');
  assert.equal(storedValidation.manifest.project.title, 'Clinic Practice (3)');
  assert.equal(storedValidation.project.meta.title, 'Clinic Practice (3)');
});

test('uploadRolePlaySceneDraft slot limit returns uploaded drafts and does not store artifact', async () => {
  const db = createFakeDb({
    draftCount: 3,
    listRows: [{ roleplayscene_uploaded_draft_id: 'r1' }],
  });
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact() {
        throw new Error('storeArtifact should not run on slot limit');
      },
    },
  });

  const result = await service.uploadRolePlaySceneDraft({
    identity,
    title: 'New Scene',
    description: '',
    zipBytes: createRolePlaySceneZip(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error.code, 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED');
  assert.equal(result.error.details.slotLimit, 3);
  assert.deepEqual(result.error.details.uploadedDrafts, [{ roleplayscene_uploaded_draft_id: 'r1' }]);
});

test('uploadRolePlaySceneDraft replace without publish marker recreates row and cleans old artifact', async () => {
  let cleanedPath = null;
  const db = createFakeDb({
    draftCount: 1,
    conflictRow: createConflictRow({ last_published_artifact_sha256: null }),
  });
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact() {
        return {
          artifactPath: 'roleplayscene/drafts/new.zip',
          absolutePath: '/tmp/new.zip',
          artifactSha256: 'sha-new',
          artifactSizeBytes: 4,
        };
      },
      resolveAbsolutePath(artifactPath) {
        cleanedPath = artifactPath;
        return '/tmp/old.zip';
      },
    },
  });

  const result = await service.uploadRolePlaySceneDraft({
    identity,
    title: 'Clinic Practice',
    description: 'Replacement',
    zipBytes: createRolePlaySceneZip(),
    conflictAction: 'replace',
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 201);
  assert.equal(result.data.replaced_roleplayscene_uploaded_draft_id, 'old-r');
  assert.notEqual(result.data.roleplayscene_uploaded_draft_id, 'old-r');
  assert.equal(cleanedPath, 'roleplayscene/drafts/old.zip');
  assert.equal(db.state.queries.some(sql => sql.includes('DELETE FROM roleplayscene_uploaded_drafts')), true);
  assert.equal(db.state.queries.some(sql => sql.includes('INSERT INTO roleplayscene_uploaded_drafts')), true);
});

test('uploadRolePlaySceneDraft replace with publish marker updates same row and preserves marker', async () => {
  const db = createFakeDb({
    draftCount: 1,
    conflictRow: createConflictRow({
      last_published_artifact_sha256: 'sha-published',
      last_published_at: '2026-05-12T00:00:00.000Z',
    }),
  });
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact() {
        return {
          artifactPath: 'roleplayscene/drafts/replacement.zip',
          absolutePath: '/tmp/replacement.zip',
          artifactSha256: 'sha-new',
          artifactSizeBytes: 4,
        };
      },
      resolveAbsolutePath() {
        return '/tmp/old.zip';
      },
    },
  });

  const result = await service.uploadRolePlaySceneDraft({
    identity,
    title: 'Clinic Practice',
    description: 'Replacement',
    zipBytes: createRolePlaySceneZip(),
    conflictAction: 'replace',
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.roleplayscene_uploaded_draft_id, 'old-r');
  assert.equal(result.data.last_published_artifact_sha256, 'sha-published');
  assert.equal(result.data.publish_state, 'unpublished_changes');
  assert.equal(db.state.queries.some(sql => sql.includes('UPDATE roleplayscene_uploaded_drafts')), true);
  assert.equal(db.state.queries.some(sql => sql.includes('DELETE FROM roleplayscene_uploaded_drafts')), false);
});

test('uploadRolePlaySceneDraft replace missing target rolls back and removes staged artifact', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roleplayscene-replace-missing-'));
  const stagedArtifactPath = path.join(tempDir, 'replacement.zip');
  await fs.writeFile(stagedArtifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const db = createFakeDb({
    draftCount: 1,
    conflictRow: createConflictRow({ last_published_artifact_sha256: 'sha-published' }),
    replaceUpdateRowCount: 0,
  });
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact() {
        return {
          artifactPath: 'roleplayscene/drafts/replacement.zip',
          absolutePath: stagedArtifactPath,
          artifactSha256: 'sha-new',
          artifactSizeBytes: 4,
        };
      },
    },
  });

  const result = await service.uploadRolePlaySceneDraft({
    identity,
    title: 'Clinic Practice',
    description: '',
    zipBytes: createRolePlaySceneZip(),
    conflictAction: 'replace',
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error.code, 'ROLEPLAYSCENE_DRAFT_REPLACE_TARGET_MISSING');
  await assert.rejects(() => fs.access(stagedArtifactPath));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('uploadRolePlaySceneDraft removes newly staged artifact when DB insert fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roleplayscene-insert-fail-'));
  const stagedArtifactPath = path.join(tempDir, 'new.zip');
  await fs.writeFile(stagedArtifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const db = createFakeDb({ failInsert: true });
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact() {
        return {
          artifactPath: 'roleplayscene/drafts/new.zip',
          absolutePath: stagedArtifactPath,
          artifactSha256: 'sha-new',
          artifactSizeBytes: 4,
        };
      },
    },
  });

  await assert.rejects(
    () => service.uploadRolePlaySceneDraft({
      identity,
      title: 'Clinic Practice',
      description: '',
      zipBytes: createRolePlaySceneZip(),
    }),
    /insert failed/
  );
  await assert.rejects(() => fs.access(stagedArtifactPath));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('deleteOwnRolePlaySceneDraft deletes row then best-effort removes artifact', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roleplayscene-delete-'));
  const artifactPath = path.join(tempDir, 'old.zip');
  await fs.writeFile(artifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const service = createService({
    db: createFakeDb({ conflictRow: createConflictRow() }),
    artifactStore: {
      resolveAbsolutePath() {
        return artifactPath;
      },
    },
  });

  const result = await service.deleteOwnRolePlaySceneDraft({
    identity,
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.roleplayscene_uploaded_draft_id, '550e8400-e29b-41d4-a716-446655440000');
  await assert.rejects(() => fs.access(artifactPath));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('deleteOwnRolePlaySceneDraft succeeds if artifact cleanup fails', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const service = createService({
    db: createFakeDb({ conflictRow: createConflictRow() }),
    artifactStore: {
      resolveAbsolutePath() {
        throw new Error('resolve failed');
      },
    },
  });

  try {
    const result = await service.deleteOwnRolePlaySceneDraft({
      identity,
      uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(result.ok, true);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('listOwnRolePlaySceneDrafts excludes artifact_path and includes publish_state', async () => {
  let capturedSql = '';
  const service = createService({
    db: {
      async query(sql) {
        capturedSql = sql;
        return {
          rows: [
            {
              roleplayscene_uploaded_draft_id: 'r1',
              title: 'Clinic',
              artifact_sha256: 'sha-new',
              last_published_artifact_sha256: 'sha-old',
              publish_state: 'unpublished_changes',
            },
          ],
          rowCount: 1,
        };
      },
    },
    artifactStore: {},
  });

  const rows = await service.listOwnRolePlaySceneDrafts({ sub: 'oidc-sub' });
  assert.equal(capturedSql.includes('artifact_path'), false);
  assert.equal(rows[0].publish_state, 'unpublished_changes');
});

test('uploadRolePlaySceneDraft succeeds with missing media and stores warning counts', async () => {
  const db = createFakeDb();
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact({ bytes }) {
        return {
          artifactPath: 'roleplayscene/drafts/missing-media.zip',
          absolutePath: '/tmp/missing-media.zip',
          artifactSha256: 'sha-warning',
          artifactSizeBytes: bytes.length,
        };
      },
    },
  });

  const result = await service.uploadRolePlaySceneDraft({
    identity,
    title: 'Clinic Practice',
    description: '',
    zipBytes: createRolePlaySceneZip({
      mediaEntries: { 'media/scene-start/image.png': 'image' },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.missing_media_count, 1);
  assert.equal(result.data.validation_warning_count, 1);
  assert.equal(result.data.warnings[0].code, 'ROLEPLAYSCENE_MEDIA_MISSING');
});
