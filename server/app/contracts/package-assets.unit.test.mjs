import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPackageAssets } from './package-assets.js';
import { crc32 } from '../../editor/zip-utils.js';
const bytes = new Uint8Array([1, 2, 3]);
const asset = () => ({ assetId: 'img', path: 'media/img.png', byteLength: bytes.length, crc32: crc32(bytes).toString(16).padStart(8, '0') });

test('asset boundary validates bytes and accepts optional legacy metadata', () => {
  assert.equal(assertPackageAssets([asset()], new Map([['media/img.png', bytes]])).get('img').byteLength, 3);
  assert.doesNotThrow(() => assertPackageAssets([{ assetId: 'img', path: 'media/img.png' }], new Map([['media/img.png', bytes]])));
});
for (const path of ['pictures/img.png', 'media/', 'media/../img.png', 'media/./img.png', 'media//img.png', 'media/a..png', 'media/a\\b.png', 'media/a\u0000.png']) {
  test(`reject invalid asset path ${JSON.stringify(path)}`, () => assert.throws(() => assertPackageAssets([{ ...asset(), path }]), /path/));
}
test('reject duplicate identities and paths', () => {
  assert.throws(() => assertPackageAssets([asset(), { ...asset(), path: 'media/other.png' }]), /assetId/);
  assert.throws(() => assertPackageAssets([asset(), { ...asset(), assetId: 'other' }]), /path/);
});
test('reject missing, empty and mismatched bytes', () => {
  for (const value of [undefined, new Uint8Array()]) assert.throws(() => assertPackageAssets([asset()], new Map([['media/img.png', value]])), /Missing or empty/);
  assert.throws(() => assertPackageAssets([{ ...asset(), byteLength: 4 }], new Map([['media/img.png', bytes]])), /byteLength mismatch/);
  assert.throws(() => assertPackageAssets([{ ...asset(), crc32: '00000000' }], new Map([['media/img.png', bytes]])), /CRC32 mismatch/);
});
