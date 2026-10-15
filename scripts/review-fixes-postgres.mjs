// Explicitly opt into an isolated test database; all tables live in a disposable schema.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PackageService } from '../server/api/services/package-service.js';
import { PackageArtifactStore } from '../server/api/storage/package-artifact-store.js';
import { createStoredZip } from '../server/editor/zip-utils.js';
import { verifyUploadOperations } from './ci/upload-operation-fixtures.mjs';

const connectionString = process.env.REVIEW_TEST_DATABASE_URL;
assert.ok(connectionString, 'Set REVIEW_TEST_DATABASE_URL to a disposable PostgreSQL database.');
const schema = `review_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString });
const db = new Pool({ connectionString, options: `-c search_path=${schema},public` });
const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-artifacts-'));
const store = new PackageArtifactStore({ storageRoot });
const config = { attemptSlotLimit: 3, draftSlotLimit: 3 };
const service = new PackageService({ db, artifactStore: store, config });
const zip = Buffer.from(createStoredZip([
  { path: 'manifest.json', data: JSON.stringify({ format: 'worksheet-attempt-package', packageVersion: 1, schemaVersion: 1 }) },
  { path: 'content/worksheet.json', data: JSON.stringify({ title: 'Fixture', blocks: [{ blockId: 'q1', kind: 'question', prompt: { text: 'Question' }, responseConfig: { inputType: 'text' } }] }) },
  { path: 'content/attempt.json', data: JSON.stringify({ schemaVersion: 1, kind: 'worksheet-attempt', status: 'in_progress', answers: { q1: 'Answer' } }) },
]));
const input = sub => ({ identity: { sub }, title: 'Fixture', zipBytes: zip });
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const dir = new URL('../server/api/db/migrations/', import.meta.url);
  const files = (await fs.readdir(dir)).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) await db.query(await fs.readFile(new URL(file, dir), 'utf8'));
  console.log(`PASS: ${files.length} migrations applied to isolated schema`);

  // Commit really reaches PostgreSQL; only the reply to the service is lost.
  const uncertainDb = { connect: async () => {
    const client = await db.connect();
    return { release: () => client.release(), query: async (sql, args) => {
      const result = await client.query(sql, args);
      if (sql === 'COMMIT') throw new Error('lost COMMIT acknowledgment');
      return result;
    } };
  } };
  const uncertainService = new PackageService({ db: uncertainDb, artifactStore: store, config });
  await assert.rejects(uncertainService.uploadAttempt(input('commit-fixture')), /lost COMMIT acknowledgment/);
  const committed = await db.query('SELECT artifact_path FROM uploaded_attempts WHERE owner_sub=$1', ['commit-fixture']);
  assert.equal(committed.rowCount, 1);
  assert.ok(await store.statArtifact(committed.rows[0].artifact_path));
  console.log('PASS: acknowledged-as-failed commit retains the committed row and readable ZIP');

  const seed = await service.uploadAttempt(input('race-fixture'));
  assert.equal(seed.ok, true);
  const id = seed.data.uploaded_attempt_id;
  const original = store.storeArtifact.bind(store);
  let release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  store.storeArtifact = async args => {
    const artifact = await original(args);
    entered();
    await new Promise(resolve => { release = resolve; });
    return artifact;
  };
  const replacing = service.uploadAttempt({ ...input('race-fixture'), conflictAction: 'replace' });
  await blocked;
  let deleteFinished = false;
  const deleting = service.deleteOwnAttempt({ identity: { sub: 'race-fixture' }, uploadedAttemptId: id }).then(result => { deleteFinished = true; return result; });
  // Wait for actual lock contention rather than treating timing alone as proof.
  let waiting = false;
  for (let i = 0; i < 100; i++) {
    const locks = await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
    if (locks.rowCount) { waiting = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  release();
  const [replacement, deletion] = await Promise.all([replacing, deleting]);
  store.storeArtifact = original;
  assert.equal(waiting, true, 'delete must wait for the owner lock');
  assert.equal(replacement.ok, true);
  assert.equal(deletion.ok, true);
  assert.equal(deleteFinished, true);
  assert.equal((await db.query('SELECT 1 FROM uploaded_attempts WHERE uploaded_attempt_id=$1', [id])).rowCount, 0);
  assert.deepEqual(await fs.readdir(path.join(storageRoot, 'attempts', 'race-fixture')), []);
  console.log('PASS: replacement/delete serialize and leave neither row nor orphan ZIP');

  const concurrent = await Promise.all(Array.from({ length: 6 }, (_, i) => service.uploadAttempt({ ...input('slot-fixture'), title: `Attempt ${i}` })));
  assert.equal(concurrent.filter(result => result.ok).length, 3);
  assert.deepEqual(concurrent.filter(result => !result.ok).map(result => result.error.code), Array(3).fill('ATTEMPT_SLOT_LIMIT_REACHED'));
  console.log('PASS: six concurrent uploads respect the three-slot limit');
  await verifyUploadOperations({ db, store, config, attemptZip: zip, storageRoot });
} finally {
  await db.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  await fs.rm(storageRoot, { recursive: true, force: true });
}
