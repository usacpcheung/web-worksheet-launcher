import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PackageService } from './package-service.js';
import { createStoredZip } from '../../editor/zip-utils.js';

function createValidAttemptZip() {
  return createStoredZip([
    {
      path: 'manifest.json',
      data: JSON.stringify({
        format: 'worksheet-attempt-package',
        packageVersion: 1,
        schemaVersion: 1,
        worksheet: { title: 'Attempt Worksheet' },
      }),
    },
    {
      path: 'content/worksheet.json',
      data: JSON.stringify({
        title: 'Attempt Worksheet',
        blocks: [{ id: 'q1', kind: 'short_text' }],
      }),
    },
    {
      path: 'content/attempt.json',
      data: JSON.stringify({
        schemaVersion: 1,
        kind: 'worksheet-attempt',
        status: 'submitted',
        answers: { q1: 'A' },
        submittedAt: '2026-04-30T00:00:00.000Z',
        checking: {
          checkedAt: '2026-04-30T00:00:01.000Z',
          items: { q1: { result: 'correct' } },
        },
      }),
    },
  ]);
}

function createAttemptDb({
  conflict = null,
  count = 0,
  attemptsListRows = [],
  onInsert = null,
  onUpdate = null,
} = {}) {
  const state = {
    queries: [],
    rollbacks: 0,
    commits: 0,
  };
  const client = {
    async query(sql, values = []) {
      state.queries.push(sql);
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      if (sql === 'COMMIT') {
        state.commits += 1;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        state.rollbacks += 1;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [{ ok: true }], rowCount: 1 };
      if (sql.includes('FROM uploaded_attempts') && sql.includes('ORDER BY created_at DESC') && sql.includes('LIMIT 1')) {
        return conflict ? { rows: [conflict], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('COUNT(*)::int AS count FROM uploaded_attempts')) return { rows: [{ count }], rowCount: 1 };
      if (sql.includes('SELECT') && sql.includes('FROM uploaded_attempts') && sql.includes('ORDER BY created_at DESC') && !sql.includes('LIMIT 1')) {
        return { rows: attemptsListRows, rowCount: attemptsListRows.length };
      }
      if (sql.includes('INSERT INTO uploaded_attempts')) {
        if (onInsert) onInsert(sql, values);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE uploaded_attempts SET')) {
        if (onUpdate) onUpdate(sql, values);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unhandled SQL in attempt test: ${sql}`);
    },
    release() {},
  };
  return {
    state,
    async connect() {
      return client;
    },
  };
}

function createService({ db, artifactStore }) {
  return new PackageService({
    db,
    artifactStore: artifactStore || {
      async storeArtifact({ artifactId }) {
        return {
          artifactPath: `attempts/oidc-sub/${artifactId}.zip`,
          absolutePath: `/tmp/${artifactId}.zip`,
          artifactSha256: 'sha',
          artifactSizeBytes: 123,
        };
      },
      resolveAbsolutePath(artifactPath) {
        return `/tmp/${artifactPath.replaceAll('/', '_')}`;
      },
    },
    config: {
      draftSlotLimit: 3,
      attemptSlotLimit: 3,
    },
  });
}

test('uploadAttempt conflict fail_on_conflict rolls back transaction', async () => {
  const db = createAttemptDb({
    conflict: {
      uploaded_attempt_id: 'a-existing',
      owner_sub: 'oidc-sub',
      title: 'A',
      subject: 'S',
      artifact_path: 'attempts/oidc-sub/a-existing.zip',
    },
    attemptsListRows: [{ uploaded_attempt_id: 'a-existing' }],
  });
  const service = createService({ db });

  const result = await service.uploadAttempt({
    identity: { sub: 'oidc-sub', email: null, name: null },
    title: 'A',
    subject: 'S',
    zipBytes: createValidAttemptZip(),
    conflictAction: 'fail_on_conflict',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ATTEMPT_NAME_CONFLICT');
  assert.equal(db.state.rollbacks, 1);
  assert.equal(db.state.commits, 0);
});

test('uploadAttempt slot limit with copy rolls back and returns ATTEMPT_SLOT_LIMIT_REACHED', async () => {
  const db = createAttemptDb({
    conflict: {
      uploaded_attempt_id: 'a-existing',
      owner_sub: 'oidc-sub',
      title: 'A',
      subject: 'S',
      artifact_path: 'attempts/oidc-sub/a-existing.zip',
    },
    count: 3,
    attemptsListRows: [{ uploaded_attempt_id: 'a-existing' }],
  });
  const service = createService({ db });

  const result = await service.uploadAttempt({
    identity: { sub: 'oidc-sub', email: null, name: null },
    title: 'A',
    subject: 'S',
    zipBytes: createValidAttemptZip(),
    conflictAction: 'copy',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ATTEMPT_SLOT_LIMIT_REACHED');
  assert.equal(result.error.details.slotLimit, 3);
  assert.equal(db.state.rollbacks, 1);
  assert.equal(db.state.commits, 0);
});

test('uploadAttempt rejects packages with non-attempt manifest format', async () => {
  const zipBytes = createStoredZip([
    {
      path: 'manifest.json',
      data: JSON.stringify({
        format: 'worksheet-package',
        packageVersion: 1,
        schemaVersion: 1,
      }),
    },
    {
      path: 'content/worksheet.json',
      data: JSON.stringify({
        title: 'Attempt Worksheet',
        blocks: [{ blockId: 'q1', kind: 'question' }],
      }),
    },
    {
      path: 'content/attempt.json',
      data: JSON.stringify({
        schemaVersion: 1,
        kind: 'worksheet-attempt',
        status: 'submitted',
        answers: { q1: { value: 'A' } },
        submittedAt: '2026-04-30T00:00:00.000Z',
      }),
    },
  ]);

  const db = createAttemptDb();
  const service = createService({ db });
  const result = await service.uploadAttempt({
    identity: { sub: 'oidc-sub', email: null, name: null },
    title: 'A',
    subject: 'S',
    zipBytes,
    conflictAction: 'fail_on_conflict',
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.error.code, 'INVALID_ATTEMPT_PACKAGE');
});

test('uploadAttempt replace stores a new artifact id and updates existing row id', async () => {
  const storeArtifactIds = [];
  let updateValues = null;
  const db = createAttemptDb({
    conflict: {
      uploaded_attempt_id: 'a-existing',
      owner_sub: 'oidc-sub',
      title: 'A',
      subject: 'S',
      artifact_path: 'attempts/oidc-sub/a-existing.zip',
    },
    onUpdate(_, values) {
      updateValues = values;
    },
  });
  const service = createService({
    db,
    artifactStore: {
      async storeArtifact({ artifactId }) {
        storeArtifactIds.push(artifactId);
        return {
          artifactPath: `attempts/oidc-sub/${artifactId}.zip`,
          absolutePath: `/tmp/${artifactId}.zip`,
          artifactSha256: 'sha',
          artifactSizeBytes: 321,
        };
      },
      resolveAbsolutePath() {
        return '/tmp/old.zip';
      },
    },
  });

  const result = await service.uploadAttempt({
    identity: { sub: 'oidc-sub', email: null, name: null },
    title: 'A',
    subject: 'S',
    zipBytes: createValidAttemptZip(),
    conflictAction: 'replace',
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.uploaded_attempt_id, 'a-existing');
  assert.equal(storeArtifactIds.length, 1);
  assert.notEqual(storeArtifactIds[0], 'a-existing');
  assert.equal(updateValues[0], 'a-existing');
  assert.equal(db.state.commits, 1);
});

test('listOwnAttempts does not select artifact_path', async () => {
  const sqlSeen = [];
  const db = {
    async query(sql) {
      sqlSeen.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };
  const service = createService({ db });
  await service.listOwnAttempts({ sub: 'oidc-sub' });
  assert.equal(sqlSeen.length, 1);
  assert.equal(sqlSeen[0].includes('artifact_path'), false);
  assert.equal(sqlSeen[0].includes('SELECT *'), false);
});

test('uploadAttempt validator accepts checking block ids from worksheet.blockId shape', async () => {
  const zipBytes = createStoredZip([
    {
      path: 'manifest.json',
      data: JSON.stringify({
        format: 'worksheet-attempt-package',
        packageVersion: 1,
        worksheet: { title: 'Attempt Worksheet' },
      }),
    },
    {
      path: 'content/worksheet.json',
      data: JSON.stringify({
        title: 'Attempt Worksheet',
        blocks: [{ blockId: 'q1', kind: 'question' }],
      }),
    },
    {
      path: 'content/attempt.json',
      data: JSON.stringify({
        schemaVersion: 1,
        kind: 'worksheet-attempt',
        status: 'checked',
        answers: { q1: { value: 'A' } },
        submittedAt: '2026-04-30T00:00:00.000Z',
        checking: {
          checkedAt: '2026-04-30T00:00:01.000Z',
          items: { q1: { result: 'correct' } },
        },
      }),
    },
  ]);

  const db = createAttemptDb();
  const service = createService({ db });
  const result = await service.uploadAttempt({
    identity: { sub: 'oidc-sub', email: null, name: null },
    title: 'A',
    subject: 'S',
    zipBytes,
    conflictAction: 'fail_on_conflict',
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 201);
});
test('unsupported text formats and disguised Markdown attempts reject before database or artifact writes', async () => {
  for (const [packageVersion, format] of [[1, 'limited-markdown-v1'], [2, 'future'], [3, 'plain_text']]) {
    let writes = 0;
    const service = createService({ db: { connect: async () => { writes += 1; throw new Error('Unexpected database access'); } },
      artifactStore: { storeArtifact: async () => { writes += 1; } } });
    const zipBytes = createStoredZip([
      { path: 'manifest.json', data: JSON.stringify({ format: 'worksheet-attempt-package', packageVersion, schemaVersion: 1 }) },
      { path: 'content/worksheet.json', data: JSON.stringify({ blocks: [{ blockId: 'q', kind: 'question', prompt: { text: '**keep**', format } }] }) },
      { path: 'content/attempt.json', data: JSON.stringify({ schemaVersion: 1, kind: 'worksheet-attempt', status: 'in_progress', answers: {} }) },
    ]);
    const result = await service.uploadAttempt({ identity: { sub: 'fixture' }, title: 'T', zipBytes, conflictAction: 'fail_on_conflict' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_ATTEMPT_PACKAGE');
    assert.equal(writes, 0);
  }
});

function loseCommitAcknowledgment(db) {
  const connect = db.connect.bind(db);
  db.connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    client.query = async (sql, values) => {
      const result = await query(sql, values);
      if (sql === 'COMMIT') throw new Error('lost COMMIT acknowledgment');
      return result;
    };
    return client;
  };
  return db;
}

test('uploadAttempt preserves its artifact if COMMIT acknowledgment is lost', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-ack-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const absolutePath = path.join(dir, 'artifact.zip');
  const service = createService({
    db: loseCommitAcknowledgment(createAttemptDb()),
    artifactStore: {
      readArtifact: async () => createValidAttemptZip(),
      storeArtifact: async () => {
        await fs.writeFile(absolutePath, 'committed artifact');
        return { absolutePath, artifactPath: 'new.zip', artifactSha256: 'new-sha', artifactSizeBytes: 18 };
      },
    },
  });
  await assert.rejects(service.uploadAttempt({ identity: { sub: 'oidc-sub' }, title: 'A', zipBytes: createValidAttemptZip() }), /lost COMMIT acknowledgment/);
  assert.equal(await fs.readFile(absolutePath, 'utf8'), 'committed artifact');
});

test('attempt replacement reports a missing row and removes the unused new artifact', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'attempt-replace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const absolutePath = path.join(dir, 'new.zip');
  const db = createAttemptDb({ conflict: { uploaded_attempt_id: 'old', artifact_path: 'old.zip' } });
  const client = await db.connect();
  const query = client.query.bind(client);
  client.query = (sql, values) => sql.includes('UPDATE uploaded_attempts SET') ? { rows: [], rowCount: 0 } : query(sql, values);
  const service = createService({ db, artifactStore: { storeArtifact: async () => {
    await fs.writeFile(absolutePath, 'unused');
    return { absolutePath, artifactPath: 'new.zip', artifactSha256: 'new-sha', artifactSizeBytes: 6 };
  } } });
  const result = await service.uploadAttempt({ identity: { sub: 'oidc-sub' }, title: 'A', zipBytes: createValidAttemptZip(), conflictAction: 'replace' });
  assert.equal(result.error.code, 'ATTEMPT_REPLACE_TARGET_MISSING');
  assert.equal(db.state.commits, 0);
  await assert.rejects(fs.stat(absolutePath), { code: 'ENOENT' });
});
