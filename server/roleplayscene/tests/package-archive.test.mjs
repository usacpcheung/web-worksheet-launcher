import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from '../scripts/vendor/fflate.module.js';
import { LOCAL_ARCHIVE_BYTES, readLocalSceneArchive, readSceneArchiveSync } from '../scripts/utils/package-archive.js';
import { prepareProjectImport, ImportErrorCode } from '../scripts/storage.js';

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
