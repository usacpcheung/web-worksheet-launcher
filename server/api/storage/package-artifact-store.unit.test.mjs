import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PackageArtifactStore } from './package-artifact-store.js';

async function createStore() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-store-'));
  return {
    storageRoot,
    store: new PackageArtifactStore({ storageRoot }),
    async cleanup() {
      await fs.rm(storageRoot, { recursive: true, force: true });
    },
  };
}

test('published artifact inventory is limited to worksheet and RolePlayScene published buckets', async (t) => {
  const fixture = await createStore();
  t.after(() => fixture.cleanup());

  await fs.mkdir(path.join(fixture.storageRoot, 'published', 'owner'), { recursive: true });
  await fs.mkdir(path.join(fixture.storageRoot, 'roleplayscene', 'published', 'owner'), { recursive: true });
  await fs.mkdir(path.join(fixture.storageRoot, 'drafts', 'owner'), { recursive: true });
  await fs.mkdir(path.join(fixture.storageRoot, 'quarantine', 'worksheet'), { recursive: true });
  await fs.writeFile(path.join(fixture.storageRoot, 'published', 'owner', 'worksheet.zip'), 'zip');
  await fs.writeFile(path.join(fixture.storageRoot, 'roleplayscene', 'published', 'owner', 'scene.zip'), 'zip');
  await fs.writeFile(path.join(fixture.storageRoot, 'drafts', 'owner', 'draft.zip'), 'zip');
  await fs.writeFile(path.join(fixture.storageRoot, 'quarantine', 'worksheet', 'old.zip'), 'zip');

  const artifacts = await fixture.store.listPublishedArtifacts();
  assert.deepEqual(
    artifacts.map((item) => item.artifactPath).sort(),
    ['published/owner/worksheet.zip', 'roleplayscene/published/owner/scene.zip']
  );
});

test('moveArtifact is idempotent when a prior copy left source and destination present', async (t) => {
  const fixture = await createStore();
  t.after(() => fixture.cleanup());
  const sourcePath = 'published/owner/source.zip';
  const destinationPath = 'quarantine/worksheet/q.zip';
  const source = fixture.store.resolveAbsolutePath(sourcePath);
  const destination = fixture.store.resolveAbsolutePath(destinationPath);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(source, 'same bytes');
  await fs.writeFile(destination, 'same bytes');

  const result = await fixture.store.moveArtifact({ sourcePath, destinationPath });
  assert.equal(result.alreadyMoved, true);
  assert.equal(await fixture.store.statArtifact(sourcePath), null);
  assert.equal((await fixture.store.statArtifact(destinationPath)).isFile, true);
});

test('moveArtifact does not discard a source when an equal-size destination has different content', async (t) => {
  const fixture = await createStore();
  t.after(() => fixture.cleanup());
  const sourcePath = 'published/owner/source.zip';
  const destinationPath = 'quarantine/worksheet/q.zip';
  const source = fixture.store.resolveAbsolutePath(sourcePath);
  const destination = fixture.store.resolveAbsolutePath(destinationPath);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(source, 'source');
  await fs.writeFile(destination, 'target');

  await assert.rejects(
    fixture.store.moveArtifact({ sourcePath, destinationPath }),
    (error) => error?.code === 'EEXIST'
  );
  assert.equal((await fixture.store.statArtifact(sourcePath)).isFile, true);
  assert.equal((await fixture.store.statArtifact(destinationPath)).isFile, true);
});

test('managed artifact operations reject draft and escaping paths', async (t) => {
  const fixture = await createStore();
  t.after(() => fixture.cleanup());

  await assert.rejects(
    fixture.store.deleteArtifact('drafts/owner/draft.zip'),
    /outside managed published buckets/
  );
  await assert.rejects(
    fixture.store.moveArtifact({
      sourcePath: 'published/owner/a.zip',
      destinationPath: '../../outside.zip',
    }),
    /outside managed published buckets/
  );
});
