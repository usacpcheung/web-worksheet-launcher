import { createStoredZip } from '../../editor/zip-utils.js';
import { readZipDirectory } from '../../app/contracts/zip-directory.js';
import { Inflate } from '../scripts/vendor/fflate.module.js';
import { deflateRawSync } from 'node:zlib';
import { validateRolePlayScenePackage, validateRolePlayScenePackageForPublish, rewriteRolePlayScenePackageTitle } from '../../api/services/roleplayscene-package.js';
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
    assert.deepEqual(readSceneArchiveSync(bytes).files.get('example.txt'), text);
    assert.deepEqual((await readLocalSceneArchive(bytes)).files.get('example.txt'), text);
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
  assert.deepEqual(readSceneArchiveSync(copy).files.get(path), text);
  assert.deepEqual((await readLocalSceneArchive(copy)).files.get(path), text);
});

function sceneArchive(scenes, media = []) {
  return createStoredZip([
    { path: 'manifest.json', data: JSON.stringify({ format: 'roleplayscene-package', packageVersion: 1 }) },
    { path: 'content/project.json', data: JSON.stringify({ scenes }) },
    ...media,
  ]);
}

test('old server copies recover unflagged UTF-8 only when a reference identifies that spelling', async () => {
  const name = 'media/相片..一.png';
  const singleByteName = Buffer.from(name).toString('latin1');
  for (const path of [name, singleByteName]) {
    const bytes = sceneArchive([{ id: 'a', type: 'start', image: { path } }], [{ path: name, data: text }]);
    const entry = readZipDirectory(bytes).find(entry => entry.name === name);
    const view = new DataView(bytes.buffer);
    const directory = view.getUint32(bytes.length - 6, true);
    let central = directory;
    while (view.getUint32(central + 42, true) !== entry.local) {
      central += 46 + view.getUint16(central + 28, true);
    }
    view.setUint16(entry.local + 6, 0, true);
    view.setUint16(central + 8, 0, true);
    for (const archive of [bytes, rewriteRolePlayScenePackageTitle(bytes, 'Copy')]) {
      const validation = validateRolePlayScenePackage(archive);
      assert.equal(validation.metadata.mediaCount, 1);
      assert.equal(validation.metadata.missingMediaCount, 0);
      const imported = await extractProjectFromArchive(archive, { includeWarnings: true });
      assert.deepEqual(imported.missingMediaPaths, []);
      assert.deepEqual(new Uint8Array(await imported.serialized.scenes[0].image.blob.arrayBuffer()), text);
    }
  }
});

test('repeated scene media shares bytes and missing filenames produce a warning', async () => {
  const audio = { path: 'media/voice', type: 'audio/ogg' };
  const bytes = sceneArchive([{ id: 's', type: 'start', backgroundAudio: audio, image: { path: 'toString' },
    dialogue: [{ audio }, { audio: { ...audio, type: 'audio/webm' } }] }], [{ path: audio.path, data: text }]);
  const { serialized, missingMediaPaths } = await extractProjectFromArchive(bytes, { includeWarnings: true });
  const scene = serialized.scenes[0];
  assert.equal(scene.image.blob, null);
  assert.deepEqual(missingMediaPaths, ['toString']);
  assert.equal(scene.backgroundAudio.blob, scene.dialogue[0].audio.blob);
  assert.equal(scene.dialogue[1].audio.blob.type, 'audio/webm');
  assert.deepEqual(new Uint8Array(await scene.dialogue[1].audio.blob.arrayBuffer()), text);
});

test('browser import, draft upload and publish reject unrepresentable scene data before use', async () => {
  const start = { id: 'start', type: 'start' };
  const cases = [
    Array.from({ length: 21 }, (_, i) => ({ id: String(i), type: i ? 'end' : 'start' })),
    [{ ...start, choices: {} }], [{ ...start, choices: [null] }],
    [{ ...start, dialogue: Array.from({ length: 4 }, () => ({ text: 'Hello' })) }],
    [{ ...start, choices: Array(4).fill({}) }],
    [{ ...start, speechBubble: { anchors: Array(5).fill({}) } }],
  ];
  for (const scenes of cases) {
    const bytes = sceneArchive(scenes);
    await assert.rejects(extractProjectFromArchive(bytes), error => error.code === ImportErrorCode.INVALID_PROJECT);
    await assert.rejects(prepareProjectImport(new File([JSON.stringify({ scenes })], 'scene.json')),
      error => error.code === ImportErrorCode.INVALID_PROJECT);
    assert.equal(validateRolePlayScenePackage(bytes).error.code, 'INVALID_ROLEPLAYSCENE_PROJECT');
    assert.equal(validateRolePlayScenePackageForPublish(bytes).error.code, 'INVALID_ROLEPLAYSCENE_PUBLISH_PACKAGE');
  }
});

test('stored DEFLATE block length complements are checked, including a split header', () => {
  const compressed = deflateRawSync(text, { level: 0 });
  const chunks = [];
  const inflater = new Inflate(chunk => chunks.push(...chunk));
  inflater.push(compressed.subarray(0, 3), false);
  inflater.push(compressed.subarray(3), true);
  assert.deepEqual(Uint8Array.from(chunks), text);
  const damaged = Buffer.from(compressed);
  damaged[3] ^= 1;
  assert.throws(() => new Inflate(() => {}).push(damaged, true));
});

test('exact media path wins over the legacy whitespace fallback in both readers', async () => {
  const path = 'media/voice.ogg';
  const spaced = path + ' ';
  const bytes = sceneArchive([{
    id: 's', type: 'start', backgroundAudio: { path: ' ' + path },
    dialogue: [{ audio: { path: spaced } }],
  }], [{ path, data: 'voice' }, { path: spaced, data: 'other voice' }]);
  const imported = await extractProjectFromArchive(bytes, { includeWarnings: true });
  assert.deepEqual(imported.missingMediaPaths, []);
  assert.equal(await imported.serialized.scenes[0].backgroundAudio.blob.text(), 'voice');
  assert.equal(await imported.serialized.scenes[0].dialogue[0].audio.blob.text(), 'other voice');
  assert.equal(validateRolePlayScenePackage(bytes).metadata.missingMediaCount, 0);
});

test('a legacy archive with a null project returns the project validation error', async () => {
  const bytes = createStoredZip([{ path: 'project.json', data: 'null' }]);
  await assert.rejects(extractProjectFromArchive(bytes), error => error.code === ImportErrorCode.INVALID_PROJECT);
});
