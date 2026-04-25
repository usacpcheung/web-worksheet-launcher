import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PackageService } from './package-service.js';

function createFakeDb({
  draftCount = 0,
  failInsert = false,
  draftExists = true,
  uploadConflict = false,
  failDelete = false,
  existingPublished = null,
} = {}) {
  const state = { draftCount, queries: [] };

  return {
    state,
    async connect() {
      return {
        async query(sql) {
          state.queries.push(sql);
          if (sql.includes('SELECT pg_advisory_xact_lock(hashtext($1))')) {
            return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 };
          }
          if (sql.includes('COUNT(*)::int AS count FROM uploaded_drafts')) {
            return { rows: [{ count: state.draftCount }], rowCount: 1 };
          }
          if (sql.includes('FROM uploaded_drafts d') && sql.includes('ORDER BY d.created_at DESC') && !sql.includes('LIMIT 1')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('LEFT JOIN published_packages p') && sql.includes('lower(regexp_replace')) {
            if (!uploadConflict) {
              return { rowCount: 0, rows: [] };
            }
            return {
              rowCount: 1,
              rows: [
                {
                  uploaded_draft_id: 'u',
                  owner_sub: 'oidc-sub',
                  title: 'T',
                  subject: 'S',
                  artifact_path: 'drafts/a.zip',
                  artifact_sha256: 'sha',
                  artifact_size_bytes: 1,
                  published_package_id: null,
                },
              ],
            };
          }
          if (sql.includes('SELECT uploaded_draft_id')) {
            if (draftExists) {
              return {
                rowCount: 1,
                rows: [
                  {
                    uploaded_draft_id: 'u',
                    owner_sub: 'oidc-sub',
                    title: 'T',
                    subject: 'S',
                    artifact_path: 'drafts/a.zip',
                    artifact_sha256: 'sha',
                    artifact_size_bytes: 1,
                  },
                ],
              };
            }
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('SELECT published_package_id, title, subject') && sql.includes('source_uploaded_draft_id')) {
            if (existingPublished) {
              return { rowCount: 1, rows: [existingPublished] };
            }
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('INSERT INTO uploaded_drafts') || sql.includes('INSERT INTO published_packages')) {
            if (failInsert) {
              throw new Error('insert failed');
            }
            return {
              rowCount: 1,
              rows: [
                {
                  published_package_id: 'p-new',
                  title: 'Published Title',
                  subject: 'Published Subject',
                  source_uploaded_draft_id: 'u',
                  owner_email: 'teacher@example.test',
                  owner_name: 'Teacher Name',
                },
              ],
            };
          }
          if (sql.includes('DELETE FROM uploaded_drafts')) {
            if (failDelete) {
              throw new Error('delete failed');
            }
            if (!draftExists) {
              return { rowCount: 0, rows: [] };
            }
            return { rowCount: 1, rows: [{ uploaded_draft_id: 'u', artifact_path: 'drafts/a.zip' }] };
          }
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`Unhandled query in fake db: ${sql}`);
        },
        release() {},
      };
    },
  };
}

function createService({ db, artifactStore }) {
  return new PackageService({
    db,
    artifactStore,
    config: {
      draftSlotLimit: 3,
      browsePageLimitDefault: 20,
      browsePageLimitMax: 100,
    },
  });
}

test('uploadDraft acquires per-owner advisory lock before counting slots', async () => {
  const db = createFakeDb({ draftCount: 3 });
  const artifactStore = {
    async storeArtifact() {
      throw new Error('storeArtifact should not be called for slot-limit path');
    },
  };

  const service = createService({ db, artifactStore });

  const result = await service.uploadDraft({
    identity: { sub: 'oidc-sub' },
    title: 'Title',
    subject: 'Math',
    zipBytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error.code, 'DRAFT_SLOT_LIMIT_REACHED');

  const lockQueryIndex = db.state.queries.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const countQueryIndex = db.state.queries.findIndex((sql) => sql.includes('COUNT(*)::int AS count FROM uploaded_drafts'));
  assert.notEqual(lockQueryIndex, -1);
  assert.notEqual(countQueryIndex, -1);
  assert.equal(lockQueryIndex < countQueryIndex, true);
});

test('uploadDraft removes artifact file when DB insert fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worksheet-upload-cleanup-'));
  const artifactPath = path.join(tempDir, 'artifact.zip');
  await fs.writeFile(artifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const db = createFakeDb({ draftCount: 0, failInsert: true });
  const artifactStore = {
    async storeArtifact() {
      return { artifactPath: 'drafts/a.zip', absolutePath: artifactPath, artifactSha256: 'sha', artifactSizeBytes: 4 };
    },
  };

  const service = createService({ db, artifactStore });

  await assert.rejects(
    () =>
      service.uploadDraft({
        identity: { sub: 'oidc-sub' },
        title: 'Title',
        subject: 'Math',
        zipBytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      }),
    /insert failed/
  );

  await assert.rejects(() => fs.access(artifactPath));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('uploadDraft returns conflict for same owner title and subject by default', async () => {
  const db = createFakeDb({ draftCount: 1, uploadConflict: true });
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact() {
        throw new Error('storeArtifact should not be called for conflict path');
      },
    },
  });

  const result = await service.uploadDraft({
    identity: { sub: 'oidc-sub' },
    title: '  t  ',
    subject: 's',
    zipBytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error.code, 'DRAFT_NAME_CONFLICT');
  assert.equal(result.error.details.existingDraft.uploaded_draft_id, 'u');
});

test('deleteOwnPublishedPackage removes owner package artifact after row delete', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worksheet-published-delete-'));
  const artifactPath = path.join(tempDir, 'published.zip');
  await fs.writeFile(artifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const service = createService({
    db: {
      async connect() {
        return {
          async query(sql) {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
              return { rows: [], rowCount: 0 };
            }
            if (sql.includes('DELETE FROM published_packages')) {
              return {
                rowCount: 1,
                rows: [{ published_package_id: 'p1', artifact_path: 'published/a.zip' }],
              };
            }
            throw new Error(`Unhandled query in deleteOwnPublishedPackage test: ${sql}`);
          },
          release() {},
        };
      },
    },
    artifactStore: {
      resolveAbsolutePath() {
        return artifactPath;
      },
    },
  });

  const result = await service.deleteOwnPublishedPackage({
    identity: { sub: 'oidc-sub' },
    publishedPackageId: '550e8400-e29b-41d4-a716-446655440000',
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  await assert.rejects(() => fs.access(artifactPath));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('publishFromDraft removes artifact file when DB insert fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worksheet-publish-cleanup-'));
  const artifactPath = path.join(tempDir, 'published.zip');
  await fs.writeFile(artifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const db = createFakeDb({ failInsert: true });
  const artifactStore = {
    async readArtifact() {
      return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    },
    async storeArtifact() {
      return { artifactPath: 'published/a.zip', absolutePath: artifactPath, artifactSha256: 'sha', artifactSizeBytes: 4 };
    },
  };

  const service = createService({ db, artifactStore });

  await assert.rejects(
    () => service.publishFromDraft({ identity: { sub: 'oidc-sub' }, uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000' }),
    /insert failed/
  );

  await assert.rejects(() => fs.access(artifactPath));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('publishFromDraft returns existing published package for same uploaded draft', async () => {
  const db = createFakeDb({
    existingPublished: {
      published_package_id: 'p-existing',
      title: 'Existing title',
      subject: 'Existing subject',
      source_uploaded_draft_id: 'u',
      owner_email: 'teacher@example.test',
      owner_name: 'Teacher',
    },
  });
  let storeArtifactCalls = 0;
  const service = createService({
    db,
    artifactStore: {
      async readArtifact() {
        return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      },
      async storeArtifact() {
        storeArtifactCalls += 1;
        return { artifactPath: 'published/a.zip', absolutePath: '/tmp/a.zip', artifactSha256: 'sha', artifactSizeBytes: 4 };
      },
    },
  });

  const result = await service.publishFromDraft({
    identity: { sub: 'oidc-sub' },
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.published_package_id, 'p-existing');
  assert.equal(storeArtifactCalls, 0);
});

test('publishFromDraft supports published title/subject overrides without mutating draft metadata', async () => {
  const db = createFakeDb();
  const insertQueries = [];
  const service = createService({
    db: {
      ...db,
      async connect() {
        const client = await db.connect();
        return {
          ...client,
          async query(sql, values) {
            if (sql.includes('INSERT INTO published_packages')) {
              insertQueries.push(values);
            }
            return client.query(sql, values);
          },
        };
      },
    },
    artifactStore: {
      async readArtifact() {
        return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      },
      async storeArtifact() {
        return { artifactPath: 'published/a.zip', absolutePath: '/tmp/a.zip', artifactSha256: 'sha', artifactSizeBytes: 4 };
      },
    },
  });

  const result = await service.publishFromDraft({
    identity: { sub: 'oidc-sub', email: 'teacher@example.test', name: 'Teacher Name' },
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Final release title',
    subject: 'Final release subject',
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 201);
  assert.equal(insertQueries.length, 1);
  assert.equal(insertQueries[0][5], 'Final release title');
  assert.equal(insertQueries[0][6], 'Final release subject');
});

test('deleteOwnDraft removes artifact file after deleting owner draft row', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worksheet-delete-cleanup-'));
  const artifactPath = path.join(tempDir, 'draft.zip');
  await fs.writeFile(artifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const db = createFakeDb({ draftExists: true });
  const service = createService({
    db,
    artifactStore: {
      resolveAbsolutePath() {
        return artifactPath;
      },
    },
  });

  const result = await service.deleteOwnDraft({
    identity: { sub: 'oidc-sub' },
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  await assert.rejects(() => fs.access(artifactPath));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('deleteOwnDraft returns owner-scoped not found without touching artifacts', async () => {
  const db = createFakeDb({ draftExists: false });
  let resolveCalled = false;
  const service = createService({
    db,
    artifactStore: {
      resolveAbsolutePath() {
        resolveCalled = true;
        return '/tmp/never-used';
      },
    },
  });

  const result = await service.deleteOwnDraft({
    identity: { sub: 'oidc-sub' },
    uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error.code, 'UPLOADED_DRAFT_NOT_FOUND');
  assert.equal(resolveCalled, false);
});

test('deleteOwnDraft succeeds when artifact cleanup path resolution fails', async () => {
  const db = createFakeDb({ draftExists: true });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const service = createService({
    db,
    artifactStore: {
      resolveAbsolutePath() {
        throw new Error('resolve failed');
      },
    },
  });

  try {
    const result = await service.deleteOwnDraft({
      identity: { sub: 'oidc-sub' },
      uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
    });

    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('deleteOwnDraft succeeds when artifact unlink fails with non-ENOENT error', async () => {
  const db = createFakeDb({ draftExists: true });
  const warnings = [];
  const originalWarn = console.warn;
  const originalUnlink = fs.unlink;
  console.warn = (...args) => warnings.push(args);
  fs.unlink = async () => {
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  };
  const service = createService({
    db,
    artifactStore: {
      resolveAbsolutePath() {
        return '/tmp/draft.zip';
      },
    },
  });

  try {
    const result = await service.deleteOwnDraft({
      identity: { sub: 'oidc-sub' },
      uploadedDraftId: '550e8400-e29b-41d4-a716-446655440000',
    });

    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(warnings.length, 1);
  } finally {
    fs.unlink = originalUnlink;
    console.warn = originalWarn;
  }
});

test('listOwnDrafts returns published-state metadata fields for uploaded draft rows', async () => {
  const service = createService({
    db: {
      async query() {
        return {
          rows: [
            {
              uploaded_draft_id: 'u1',
              title: 'Draft 1',
              subject: 'Math',
              published_package_id: 'p1',
              published_title: 'Released Draft 1',
              published_subject: 'Algebra',
              published_owner_email: 'teacher@example.test',
              published_owner_name: 'Teacher Name',
              published_at: '2026-04-07T15:42:00.000Z',
            },
          ],
        };
      },
    },
    artifactStore: {},
  });

  const rows = await service.listOwnDrafts({ sub: 'oidc-sub' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].published_package_id, 'p1');
  assert.equal(rows[0].published_owner_email, 'teacher@example.test');
  assert.equal(rows[0].published_owner_name, 'Teacher Name');
});

test('listPublished owner filter uses owner_email-compatible predicate ordering', async () => {
  let capturedSql = '';
  let capturedValues = null;
  const service = createService({
    db: {
      async query(sql, values) {
        capturedSql = sql;
        capturedValues = values;
        return { rows: [] };
      },
    },
    artifactStore: {},
  });

  const result = await service.listPublished({
    query: '',
    title: '',
    subject: '',
    owner: 'teacher@example.test',
    limit: 10,
    offset: 0,
  });

  assert.equal(capturedSql.includes('(lower(owner_email) LIKE $1 OR lower(owner_name) LIKE $1)'), true);
  assert.deepEqual(capturedValues, ['%teacher@example.test%', 11, 0]);
  assert.deepEqual(result, { items: [], limit: 10, offset: 0, hasMore: false });
});

test('listPublished owner filter keeps owner_email predicate when title/subject filters are also present', async () => {
  let capturedSql = '';
  let capturedValues = null;
  const service = createService({
    db: {
      async query(sql, values) {
        capturedSql = sql;
        capturedValues = values;
        return {
          rows: [
            { published_package_id: 'p3', title: 'Algebra C' },
            { published_package_id: 'p2', title: 'Algebra B' },
            { published_package_id: 'p1', title: 'Algebra A' },
          ],
        };
      },
    },
    artifactStore: {},
  });

  const result = await service.listPublished({
    query: '',
    title: 'algebra',
    subject: 'math',
    owner: 'teacher@example.test',
    limit: 2,
    offset: 4,
  });

  assert.equal(capturedSql.includes('lower(title) LIKE $1'), true);
  assert.equal(capturedSql.includes('lower(subject) LIKE $2'), true);
  assert.equal(capturedSql.includes('(lower(owner_email) LIKE $3 OR lower(owner_name) LIKE $3)'), true);
  assert.deepEqual(capturedValues, ['%algebra%', '%math%', '%teacher@example.test%', 3, 4]);
  assert.deepEqual(result, {
    items: [
      { published_package_id: 'p3', title: 'Algebra C' },
      { published_package_id: 'p2', title: 'Algebra B' },
    ],
    limit: 2,
    offset: 4,
    hasMore: true,
    nextOffset: 6,
  });
});

test('listPublished supports q compatibility filter across title/subject/owner fields', async () => {
  let capturedSql = '';
  let capturedValues = null;
  const service = createService({
    db: {
      async query(sql, values) {
        capturedSql = sql;
        capturedValues = values;
        return { rows: [] };
      },
    },
    artifactStore: {},
  });

  await service.listPublished({
    query: 'fractions',
    title: '',
    subject: '',
    owner: '',
    limit: 10,
    offset: 5,
  });

  assert.equal(
    capturedSql.includes(
      '(lower(title) LIKE $1 OR lower(subject) LIKE $1 OR lower(owner_email) LIKE $1 OR lower(owner_name) LIKE $1)'
    ),
    true
  );
  assert.deepEqual(capturedValues, ['%fractions%', 11, 5]);
});
