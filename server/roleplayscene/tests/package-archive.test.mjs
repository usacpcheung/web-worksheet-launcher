import { validateRolePlayScenePackage, rewriteRolePlayScenePackageTitle } from '../../api/services/roleplayscene-package.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from '../scripts/vendor/fflate.module.js';
import { LOCAL_ARCHIVE_BYTES, readLocalSceneArchive, readSceneArchiveSync } from '../scripts/utils/package-archive.js';
import { extractProjectFromArchive, prepareProjectImport, ImportErrorCode } from '../scripts/storage.js';

const text = new TextEncoder().encode('Small archive fixture');
const archive = level => zipSync({ 'example.txt': text }, { level });

test('local scene file size is checked before reading file contents', async () => {
  let read = false;
  const file = { name: 'scene.zip', size: LOCAL_ARCHIVE_BYTES + 1, arrayBuffer() { read = true; } };
  await assert.rejects(prepareProjectImport(file), error => error.code === ImportErrorCode.ZIP_LIMIT);
  assert.equal(read, false);
});

for (const level of [0, 6]) {
  test(`server and browser accept the same scene entry (compression level ${level})`, async () => {
    const bytes = archive(level);
    assert.deepEqual(readSceneArchiveSync(bytes).get('example.txt'), text);
    assert.deepEqual((await readLocalSceneArchive(bytes))['example.txt'], text);
  });

  test(`server and browser reject inconsistent output size (compression level ${level})`, async () => {
    const bytes = archive(level);
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.length - 6, true);
    view.setUint32(22, text.length - 1, true);
    view.setUint32(central + 24, text.length - 1, true);
    assert.throws(() => readSceneArchiveSync(bytes), /size/);
    await assert.rejects(readLocalSceneArchive(bytes), /size/);
  });
}

test('both readers reject even a single unused byte at the end of a compressed entry', async () => {
  const original = archive(6);
  const directory = new DataView(original.buffer).getUint32(original.length - 6, true);
  const bytes = new Uint8Array(original.length + 1);
  bytes.set(original.subarray(0, directory));
  bytes.set(original.subarray(directory), directory + 1);
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 6, directory + 1, true);
  const size = view.getUint32(18, true) + 1;
  view.setUint32(18, size, true);
  view.setUint32(directory + 1 + 20, size, true);
  assert.throws(() => readSceneArchiveSync(bytes), /trailing compressed data/);
  await assert.rejects(readLocalSceneArchive(bytes), /trailing compressed data/);
});

test('legacy Latin-1 media references survive local import, server validation and title rewrite', async () => {
  const path = 'media/café.png';
  const manifest = { format: 'roleplayscene-package', packageVersion: 1, assets: [{ path }] };
  const project = { scenes: [{ id: 's', type: 'start', image: { name: 'cover', path } }] };
  const encode = value => new TextEncoder().encode(JSON.stringify(value));
  const bytes = zipSync({ 'manifest.json': encode(manifest), 'content/project.json': encode(project),
    'media/cafe.png': text });
  // fflate wrote the ASCII placeholder without the UTF-8 flag. Put the
  // original ISO-8859-1 filename in both headers to model the legacy writer.
  const needle = Buffer.from('media/cafe.png');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = buffer.indexOf(needle), second = buffer.lastIndexOf(needle);
  assert.ok(first >= 0 && second > first);
  bytes[first + 9] = bytes[second + 9] = 0xe9;
  const imported = await extractProjectFromArchive(bytes, { includeWarnings: true });
  assert.deepEqual(imported.missingMediaPaths, []);
  assert.deepEqual(new Uint8Array(await imported.serialized.scenes[0].image.blob.arrayBuffer()), text);
  assert.equal(validateRolePlayScenePackage(bytes).metadata.missingMediaCount, 0);
  const copy = rewriteRolePlayScenePackageTitle(bytes, 'Copy');
  assert.deepEqual(readSceneArchiveSync(copy).get(path), text);
  assert.deepEqual((await readLocalSceneArchive(copy))[path], text);
});
