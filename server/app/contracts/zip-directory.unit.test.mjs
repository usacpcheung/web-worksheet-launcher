import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoredZip, parseStoredZip } from '../../editor/zip-utils.js';
import { readZipDirectory } from './zip-directory.js';

const fixture = () => createStoredZip([{ path: 'a', data: 'abc' }, { path: 'b', data: 'de' }]);

test('package preflight accepts exact bounds and rejects one over each configured budget', () => {
  const bytes = fixture();
  const exact = { maxEntries: 2, maxEntryBytes: 3, maxUncompressedBytes: 5, maxEntryNameLength: 1 };
  assert.equal(readZipDirectory(bytes, { limits: exact }).length, 2);
  for (const key of Object.keys(exact)) {
    assert.throws(() => readZipDirectory(bytes, { limits: { ...exact, [key]: exact[key] - 1 } }),
      e => e.code === 'ZIP_RESOURCE_LIMIT' && e.details.limit === key);
  }
});

test('worksheet reader checks later entry structure before earlier content checksums', () => {
  const bytes = fixture();
  const [first, second] = readZipDirectory(bytes);
  bytes[first.dataStart] ^= 1;
  bytes[second.local] = 0;
  assert.throws(() => parseStoredZip(bytes), /local header/);
});

test('stored archive ranges must be disjoint, including local header space', () => {
  const bytes = fixture();
  const [first] = readZipDirectory(bytes);
  const view = new DataView(bytes.buffer);
  const central = view.getUint32(bytes.length - 6, true);
  for (const offset of [first.local + 18, first.local + 22, central + 20, central + 24]) {
    view.setUint32(offset, 4, true);
  }
  assert.throws(() => parseStoredZip(bytes), /overlapping entries/);
});

test('streaming ZIP descriptors can have a CRC equal to the optional signature', () => {
  const data = Uint8Array.of(172, 10, 122, 213);
  const original = createStoredZip([{ path: 'x', data }]);
  const central = new DataView(original.buffer).getUint32(original.length - 6, true);
  for (const signed of [true, false]) {
    const descriptor = new Uint8Array(signed ? 16 : 12);
    const fields = new DataView(descriptor.buffer);
    const offset = signed ? 4 : 0;
    if (signed) fields.setUint32(0, 0x08074b50, true);
    fields.setUint32(offset, 0x08074b50, true);
    fields.setUint32(offset + 4, data.length, true);
    fields.setUint32(offset + 8, data.length, true);
    const archive = new Uint8Array(original.length + descriptor.length);
    archive.set(original.subarray(0, central));
    archive.set(descriptor, central);
    const directory = central + descriptor.length;
    archive.set(original.subarray(central), directory);
    const view = new DataView(archive.buffer);
    view.setUint32(archive.length - 6, directory, true);
    view.setUint16(6, 8, true);
    view.setUint16(directory + 8, 8, true);
    archive.fill(0, 14, 26);
    assert.deepEqual(parseStoredZip(archive).get('x'), data);
    archive[central + descriptor.length - 1] ^= 1;
    assert.throws(() => parseStoredZip(archive), /descriptor mismatch/);
  }
});
