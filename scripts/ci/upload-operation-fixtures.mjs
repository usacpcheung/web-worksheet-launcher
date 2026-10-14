import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PackageService } from '../../server/api/services/package-service.js';
import { RolePlaySceneDraftService } from '../../server/api/services/roleplayscene-draft-service.js';
import { createStoredZip, parseStoredZip } from '../../server/editor/zip-utils.js';
import { verifyLateCommitOverHttp } from './upload-operation-http-fixtures.mjs';

const zipped = entries => Buffer.from(createStoredZip(entries.map(([path, data]) => ({ path, data: JSON.stringify(data) }))));
const worksheetZip = zipped([
  ['manifest.json', { format: 'worksheet-package', packageVersion: 1, schemaVersion: 1, assets: [] }],
  ['content/worksheet.json', { title: 'Fixture', blocks: [{ blockId: 'q1', kind: 'question', prompt: { text: 'Question' }, responseConfig: { inputType: 'text' } }] }],
]);
const sceneZip = zipped([
  ['manifest.json', { format: 'roleplayscene-package', packageVersion: 1, assets: [] }],
  ['content/project.json', { meta: { title: 'Fixture' }, scenes: [
    { id: 'start', type: 'start', dialogue: [{ text: 'Hello' }], choices: [{ id: 'next', label: 'Finish', nextSceneId: 'end' }] },
    { id: 'end', type: 'end', dialogue: [], choices: [] },
  ] }],
]);
const canonical = value => JSON.parse(JSON.stringify(value));

export async function verifyUploadOperations({ db, store, config, attemptZip, storageRoot }) {
  const worksheet = new PackageService({ db, artifactStore: store, config });
  const scene = new RolePlaySceneDraftService({ db, artifactStore: store, config });
  const kinds = [
    { kind: 'worksheet-draft', instance: worksheet, Service: PackageService, method: 'uploadDraft', zipBytes: worksheetZip, table: 'uploaded_drafts', id: 'uploaded_draft_id', bucket: 'drafts' },
    { kind: 'worksheet-attempt', instance: worksheet, Service: PackageService, method: 'uploadAttempt', zipBytes: attemptZip, table: 'uploaded_attempts', id: 'uploaded_attempt_id', bucket: 'attempts' },
    { kind: 'roleplayscene-draft', instance: scene, Service: RolePlaySceneDraftService, method: 'uploadRolePlaySceneDraft', zipBytes: sceneZip, table: 'roleplayscene_uploaded_drafts', id: 'roleplayscene_uploaded_draft_id', bucket: 'roleplayscene/drafts' },
  ];
  for (const spec of kinds) {
    const identity = { sub: `idempotency-${spec.kind}` };
    const operationId = randomUUID();
    const input = { identity, operationId, title: 'Fixture', zipBytes: spec.zipBytes, conflictAction: 'copy' };
    const upload = data => spec.instance[spec.method](data);
    const results = await Promise.all(Array.from({ length: 6 }, () => upload(input)));
    assert.equal(results[0].ok, true, JSON.stringify(results[0]));
    for (const result of results) assert.deepEqual(canonical(result), canonical(results[0]));
    assert.equal((await db.query(`SELECT 1 FROM ${spec.table} WHERE owner_sub=$1`, [identity.sub])).rowCount, 1);
    assert.equal((await fs.readdir(path.join(storageRoot, spec.bucket, identity.sub))).length, 1);
    const status = await worksheet.getUploadOperation(identity, operationId);
    assert.equal(status.state, 'completed');
    assert.equal(status.kind, spec.kind);
    assert.deepEqual(status.result, canonical(results[0]));
    assert.equal((await worksheet.getUploadOperation({ sub: 'another-owner' }, operationId)).state, 'unknown');
    assert.equal((await upload({ ...input, title: 'Changed' })).error.code, 'UPLOAD_OPERATION_MISMATCH');
    assert.equal((await upload({ ...input, conflictAction: 'replace' })).error.code, 'UPLOAD_OPERATION_MISMATCH');
    const changedZip = Buffer.from(createStoredZip([
      ...[...parseStoredZip(spec.zipBytes)].map(([path, data]) => ({ path, data })),
      { path: 'operation-marker.txt', data: 'different package bytes' },
    ]));
    assert.equal((await upload({ ...input, zipBytes: changedZip })).error.code, 'UPLOAD_OPERATION_MISMATCH');
    const differentKind = kinds.find(candidate => candidate.kind !== spec.kind);
    const crossKind = await differentKind.instance[differentKind.method]({ ...input, zipBytes: differentKind.zipBytes });
    assert.equal(crossKind.error.code, 'UPLOAD_OPERATION_MISMATCH');
    const other = await upload({ ...input, identity: { sub: `other-${spec.kind}` } });
    assert.equal(other.ok, true, 'the same UUID is independently scoped to another owner');

    // A new explicit copy has a new key; concurrent retries of it use one slot.
    const copyInput = { ...input, operationId: randomUUID() };
    const copies = await Promise.all([upload(copyInput), upload(copyInput)]);
    assert.equal(copies[0].ok, true);
    assert.deepEqual(canonical(copies[0]), canonical(copies[1]));
    assert.equal((await db.query(`SELECT 1 FROM ${spec.table} WHERE owner_sub=$1`, [identity.sub])).rowCount, 2);

    const replacement = { ...input, conflictAction: 'replace', operationId: randomUUID() };
    const replaced = await upload(replacement);
    assert.equal(replaced.ok, true);
    assert.deepEqual(canonical(await upload(replacement)), canonical(replaced));
    const replacementFiles = (await fs.readdir(path.join(storageRoot, spec.bucket, identity.sub))).sort();
    assert.equal(replacementFiles.length, 2);

    // Receipt survives deletion; replay never resurrects the item or writes a ZIP.
    await db.query(`DELETE FROM ${spec.table} WHERE ${spec.id}=$1`, [replaced.data[spec.id]]);
    assert.deepEqual(canonical(await upload(replacement)), canonical(replaced));
    assert.equal((await db.query(`SELECT 1 FROM ${spec.table} WHERE ${spec.id}=$1`, [replaced.data[spec.id]])).rowCount, 0);
    assert.deepEqual((await fs.readdir(path.join(storageRoot, spec.bucket, identity.sub))).sort(), replacementFiles);

    // A receipt inside an unfinished transaction must not report success yet.
    const inFlight = { ...input, identity: { sub: `pending-${spec.kind}` }, operationId: randomUUID() };
    let reachedCommit;
    let finishCommit;
    const ready = new Promise(resolve => { reachedCommit = resolve; });
    const proceed = new Promise(resolve => { finishCommit = resolve; });
    const pausedDb = { async connect() {
      const client = await db.connect();
      return { release: () => client.release(), async query(sql, values) {
        if (sql === 'COMMIT') { reachedCommit(); await proceed; }
        return client.query(sql, values);
      } };
    } };
    const pending = new spec.Service({ db: pausedDb, artifactStore: store, config })[spec.method](inFlight);
    try {
      await Promise.race([ready, pending.then(result => { throw Error(`Upload finished before commit pause: ${JSON.stringify(result)}`); })]);
      assert.equal((await worksheet.getUploadOperation(inFlight.identity, inFlight.operationId)).state, 'unknown');
      assert.equal((await db.query(`SELECT 1 FROM ${spec.table} WHERE owner_sub=$1`, [inFlight.identity.sub])).rowCount, 0);
    } finally {
      finishCommit();
      await pending;
    }
    assert.equal((await worksheet.getUploadOperation(inFlight.identity, inFlight.operationId)).state, 'completed');

    // Lose the acknowledgment after the real commit, then retry on a fresh connection.
    const lost = { ...input, identity: { sub: `lost-${spec.kind}` }, operationId: randomUUID() };
    const uncertainDb = { async connect() {
      const client = await db.connect();
      return { release: () => client.release(), async query(sql, values) {
        const result = await client.query(sql, values);
        if (sql === 'COMMIT') throw Error('lost receipt commit reply');
        return result;
      } };
    } };
    const uncertain = new spec.Service({ db: uncertainDb, artifactStore: store, config });
    await assert.rejects(uncertain[spec.method](lost), /lost receipt commit reply/);
    const recovered = await upload(lost);
    assert.equal(recovered.ok, true);
    assert.equal((await worksheet.getUploadOperation(lost.identity, lost.operationId)).state, 'completed');
    assert.equal((await db.query(`SELECT 1 FROM ${spec.table} WHERE owner_sub=$1`, [lost.identity.sub])).rowCount, 1);
    assert.equal((await fs.readdir(path.join(storageRoot, spec.bucket, lost.identity.sub))).length, 1);

    // Failure writing the receipt must roll back the uploaded item and clean its file.
    const failed = { ...input, identity: { sub: `rollback-${spec.kind}` }, operationId: randomUUID() };
    const failingDb = { async connect() {
      const client = await db.connect();
      return { release: () => client.release(), query(sql, values) {
        if (sql.includes('INSERT INTO upload_operations')) throw Error('receipt storage unavailable');
        return client.query(sql, values);
      } };
    } };
    await assert.rejects(new spec.Service({ db: failingDb, artifactStore: store, config })[spec.method](failed), /receipt storage unavailable/);
    assert.equal((await worksheet.getUploadOperation(failed.identity, failed.operationId)).state, 'unknown');
    assert.equal((await db.query(`SELECT 1 FROM ${spec.table} WHERE owner_sub=$1`, [failed.identity.sub])).rowCount, 0);
    assert.deepEqual(await fs.readdir(path.join(storageRoot, spec.bucket, failed.identity.sub)), []);
    assert.equal((await upload(failed)).ok, true, 'rolled-back operation can be retried');

    // Failed replacements must restore both the old row and its original ZIP.
    const beforeFailure = (await db.query(`SELECT * FROM ${spec.table} WHERE owner_sub=$1`, [failed.identity.sub])).rows[0];
    const beforeBytes = await store.readArtifact(beforeFailure.artifact_path);
    const failedReplace = { ...failed, operationId: randomUUID(), conflictAction: 'replace', zipBytes: changedZip };
    await assert.rejects(new spec.Service({ db: failingDb, artifactStore: store, config })[spec.method](failedReplace), /receipt storage unavailable/);
    assert.deepEqual((await db.query(`SELECT * FROM ${spec.table} WHERE owner_sub=$1`, [failed.identity.sub])).rows[0], beforeFailure);
    assert.deepEqual(await store.readArtifact(beforeFailure.artifact_path), beforeBytes);
    assert.equal((await fs.readdir(path.join(storageRoot, spec.bucket, failed.identity.sub))).length, 1);
    assert.equal((await worksheet.getUploadOperation(failed.identity, failedReplace.operationId)).state, 'unknown');

    // Different requests racing for one key must produce exactly one winner.
    const racing = { ...input, identity: { sub: `mismatch-race-${spec.kind}` }, operationId: randomUUID() };
    const winners = await Promise.all([upload(racing), upload({ ...racing, title: 'Changed request' })]);
    assert.equal(winners.filter(result => result.ok).length, 1);
    assert.equal(winners.find(result => !result.ok).error.code, 'UPLOAD_OPERATION_MISMATCH');
    assert.equal((await db.query(`SELECT 1 FROM ${spec.table} WHERE owner_sub=$1`, [racing.identity.sub])).rowCount, 1);
    assert.equal((await fs.readdir(path.join(storageRoot, spec.bucket, racing.identity.sub))).length, 1);

    // Replay succeeds even with full slots; rejected and invalid operations leave no receipt.
    const full = { ...input, identity: { sub: `full-${spec.kind}` }, operationId: randomUUID() };
    const original = await upload(full);
    assert.equal(original.ok, true);
    for (let i = 0; i < 2; i++) assert.equal((await upload({ ...full, operationId: randomUUID() })).ok, true);
    assert.deepEqual(canonical(await upload(full)), canonical(original));
    const overflow = { ...full, operationId: randomUUID() };
    assert.equal((await upload(overflow)).statusCode, 409);
    assert.equal((await worksheet.getUploadOperation(full.identity, overflow.operationId)).state, 'unknown');
    const invalid = { ...full, operationId: randomUUID(), zipBytes: Buffer.from('invalid ZIP') };
    assert.equal((await upload(invalid)).statusCode, 400);
    assert.equal((await worksheet.getUploadOperation(full.identity, invalid.operationId)).state, 'unknown');
    assert.equal((await db.query('SELECT 1 FROM upload_operations WHERE owner_sub=$1', [full.identity.sub])).rowCount, 3);
    await verifyLateCommitOverHttp({ db, store, config, spec });

    if (spec.kind !== 'worksheet-attempt') {
      // Delete can win while a draft replacement is writing its new ZIP. The
      // replacement must not recreate a draft after the delete already succeeded.
      const deletedInput = { ...input, identity: { sub: `delete-race-${spec.kind}` }, operationId: randomUUID() };
      const toDelete = await upload(deletedInput);
      assert.equal(toDelete.ok, true);
      let enteredWrite;
      let finishWrite;
      const written = new Promise(resolve => { enteredWrite = resolve; });
      const resume = new Promise(resolve => { finishWrite = resolve; });
      const pausedStore = Object.create(store);
      pausedStore.storeArtifact = async args => {
        const artifact = await store.storeArtifact(args);
        enteredWrite();
        await resume;
        return artifact;
      };
      const replacingInput = { ...deletedInput, operationId: randomUUID(), conflictAction: 'replace' };
      const replacing = new spec.Service({ db, artifactStore: pausedStore, config })[spec.method](replacingInput);
      let replacedAfterDelete;
      try {
        await Promise.race([written, replacing.then(result => { throw Error(`Replacement exited before write pause: ${JSON.stringify(result)}`); })]);
        const deletion = spec.kind === 'worksheet-draft'
          ? await worksheet.deleteOwnDraft({ identity: deletedInput.identity, uploadedDraftId: toDelete.data[spec.id] })
          : await scene.deleteOwnRolePlaySceneDraft({ identity: deletedInput.identity, uploadedDraftId: toDelete.data[spec.id] });
        assert.equal(deletion.ok, true);
      } finally {
        finishWrite();
        replacedAfterDelete = await replacing;
      }
      assert.equal(replacedAfterDelete.statusCode, 409, 'a deleted replacement target cannot be recreated');
      assert.equal((await db.query(`SELECT 1 FROM ${spec.table} WHERE owner_sub=$1`, [deletedInput.identity.sub])).rowCount, 0);
      assert.deepEqual(await fs.readdir(path.join(storageRoot, spec.bucket, deletedInput.identity.sub)), []);
      assert.equal((await worksheet.getUploadOperation(deletedInput.identity, replacingInput.operationId)).state, 'unknown');

      const publishedInput = { ...input, identity: { sub: `published-${spec.kind}` }, operationId: randomUUID() };
      const draft = await upload(publishedInput);
      assert.equal(draft.ok, true);
      const published = spec.kind === 'worksheet-draft'
        ? await worksheet.publishFromDraft({ identity: publishedInput.identity, uploadedDraftId: draft.data[spec.id] })
        : await scene.publishRolePlaySceneFromDraft({ identity: publishedInput.identity, uploadedDraftId: draft.data[spec.id] });
      assert.equal(published.ok, true, JSON.stringify(published));
      const update = { ...publishedInput, conflictAction: 'replace', operationId: randomUUID() };
      const replacedPublished = await upload(update);
      assert.equal(replacedPublished.ok, true);
      assert.equal(replacedPublished.data[spec.id], draft.data[spec.id], 'published draft identity is retained');
      assert.deepEqual(canonical(await upload(update)), canonical(replacedPublished));
      assert.equal((await fs.readdir(path.join(storageRoot, spec.bucket, publishedInput.identity.sub))).length, 1);
    }
    console.log(`PASS: ${spec.kind} concurrent replay, owner isolation, copy/replace, deletion, lost commit reply and receipt rollback`);
  }
}
