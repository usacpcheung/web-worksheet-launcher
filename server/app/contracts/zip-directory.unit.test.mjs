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
