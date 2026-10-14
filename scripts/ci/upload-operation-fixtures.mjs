import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PackageService } from '../../server/api/services/package-service.js';
import { RolePlaySceneDraftService } from '../../server/api/services/roleplayscene-draft-service.js';
import { createStoredZip, parseStoredZip } from '../../server/editor/zip-utils.js';

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

    if (spec.kind !== 'worksheet-attempt') {
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
