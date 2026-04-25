import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorksheetPackageFromDraft,
  mapLegacyJsonToPackageModel,
  parseWorksheetPackage,
  rewriteWorksheetPackageTitle,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
} from './worksheet-package.js';
import { createStoredZip, crc32 } from './zip-utils.js';

test('createWorksheetPackageFromDraft + parseWorksheetPackage round-trip with media assets', () => {
  const draft = {
    localId: 'draft_1',
    title: 'Package test',
    blocks: [
      {
        blockId: 'q_1',
        kind: 'question',
        position: 0,
        prompt: {
          text: 'Prompt',
          format: 'plain_text',
          mediaRefs: [
            { assetId: 'asset_img_1', usage: 'question_image' },
            { assetId: 'asset_audio_1', usage: 'question_audio' },
          ],
        },
        responseConfig: {
          inputType: 'multiple_choice',
          options: [
            { id: 'opt_1', value: 'A', label: 'A', mediaRefs: [{ assetId: 'asset_opt_audio_1', usage: 'option_audio' }] },
          ],
        },
      },
    ],
    assets: [
      { assetId: 'asset_img_1', kind: 'image', usage: 'question_image', mimeType: 'image/png', path: 'media/q1.png' },
      { assetId: 'asset_audio_1', kind: 'audio', usage: 'question_audio', mimeType: 'audio/mpeg', path: 'media/q1.mp3' },
      { assetId: 'asset_opt_audio_1', kind: 'audio', usage: 'option_audio', mimeType: 'audio/mpeg', path: 'media/opt1.mp3' },
    ],
    metadata: { createdAt: '2026-04-03T00:00:00.000Z', updatedAt: '2026-04-03T00:00:00.000Z', origin: 'local_created' },
  };

  const assetById = new Map([
    ['asset_img_1', { binary: new Uint8Array([1, 2, 3, 4]) }],
    ['asset_audio_1', { binary: new Uint8Array([10, 11, 12]) }],
    ['asset_opt_audio_1', { binary: new Uint8Array([100, 101]) }],
  ]);

  const zip = createWorksheetPackageFromDraft(draft, assetById);
  const parsed = parseWorksheetPackage(zip.bytes.buffer);

  assert.equal(parsed.manifest.format, 'worksheet-package');
  assert.equal(parsed.manifest.assets.length, 3);
  assert.equal(parsed.worksheet.blocks[0].prompt.mediaRefs.length, 2);
  assert.equal(parsed.worksheet.blocks[0].responseConfig.options[0].mediaRefs[0].usage, 'option_audio');
});

test('mapLegacyJsonToPackageModel rejects invalid legacy JSON and maps valid legacy JSON', () => {
  assert.throws(
    () => mapLegacyJsonToPackageModel({ title: 'bad' }),
    /non-empty blocks array/
  );

  const mapped = mapLegacyJsonToPackageModel({
    title: 'legacy',
    blocks: [{ blockId: 'c1', kind: 'content', content: { text: 'hello' } }],
  });

  assert.equal(mapped.worksheet.title, 'legacy');
  assert.equal(mapped.assets.length, 0);
  assert.equal(mapped.manifest.format, 'worksheet-package');
});

test('rewriteWorksheetPackageTitle updates manifest and worksheet title while preserving assets', () => {
  const assetBytes = new Uint8Array([9, 8, 7, 6]);
  const checksum = crc32(assetBytes).toString(16).padStart(8, '0');
  const zipBytes = createStoredZip([
    {
      path: 'manifest.json',
      data: JSON.stringify({
        format: PACKAGE_FORMAT,
        packageVersion: PACKAGE_VERSION,
        assets: [
          { assetId: 'img1', path: 'media/img1.png', kind: 'image', usage: 'question_image', byteLength: 4, crc32: checksum },
        ],
        worksheet: { title: 'Original title', localDraftId: 'draft_1' },
      }),
    },
    { path: 'content/worksheet.json', data: JSON.stringify({ title: 'Original title', blocks: [] }) },
    { path: 'media/img1.png', data: assetBytes },
  ]);

  const rewritten = rewriteWorksheetPackageTitle(zipBytes, 'Original title (2)');
  const parsed = parseWorksheetPackage(rewritten);

  assert.equal(parsed.manifest.worksheet.title, 'Original title (2)');
  assert.equal(parsed.manifest.worksheet.localDraftId, 'draft_1');
  assert.equal(parsed.worksheet.title, 'Original title (2)');
  assert.equal(parsed.assets.length, 1);
  assert.deepEqual(Array.from(parsed.assets[0].binary), Array.from(assetBytes));
});

function makeMinimalZip({ manifestOverride, worksheetOverride, extraEntries = [] } = {}) {
  const manifest = JSON.stringify(manifestOverride ?? {
    format: PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION,
    assets: [],
  });
  const worksheet = JSON.stringify(worksheetOverride ?? { title: 'T', blocks: [] });
  return createStoredZip([
    { path: 'manifest.json', data: manifest },
    { path: 'content/worksheet.json', data: worksheet },
    ...extraEntries,
  ]);
}

test('parseWorksheetPackage throws clear error when manifest.json is missing', () => {
  const zipBytes = createStoredZip([
    { path: 'content/worksheet.json', data: '{}' },
  ]);
  assert.throws(
    () => parseWorksheetPackage(zipBytes.buffer),
    /missing required file manifest\.json/
  );
});

test('parseWorksheetPackage throws clear error when content/worksheet.json is missing', () => {
  const zipBytes = createStoredZip([
    { path: 'manifest.json', data: JSON.stringify({ format: PACKAGE_FORMAT, packageVersion: PACKAGE_VERSION, assets: [] }) },
  ]);
  assert.throws(
    () => parseWorksheetPackage(zipBytes.buffer),
    /missing required file content\/worksheet\.json/
  );
});

test('parseWorksheetPackage rejects ZIP with duplicate entry names', () => {
  const zipBytes = createStoredZip([
    { path: 'manifest.json', data: 'first' },
    { path: 'manifest.json', data: 'second' },
  ]);
  assert.throws(
    () => parseWorksheetPackage(zipBytes.buffer),
    /duplicate entry name/
  );
});

test('parseWorksheetPackage rejects manifest with duplicate assetId', () => {
  const imgBytes = new Uint8Array([1, 2]);
  const checksum = crc32(imgBytes).toString(16).padStart(8, '0');
  const zipBytes = createStoredZip([
    {
      path: 'manifest.json',
      data: JSON.stringify({
        format: PACKAGE_FORMAT,
        packageVersion: PACKAGE_VERSION,
        assets: [
          { assetId: 'dup', path: 'media/a.png', kind: 'image', usage: 'question_image', byteLength: 2, crc32: checksum },
          { assetId: 'dup', path: 'media/b.png', kind: 'image', usage: 'question_image', byteLength: 2, crc32: checksum },
        ],
      }),
    },
    { path: 'content/worksheet.json', data: JSON.stringify({ title: 'T', blocks: [] }) },
    { path: 'media/a.png', data: imgBytes },
    { path: 'media/b.png', data: imgBytes },
  ]);
  assert.throws(
    () => parseWorksheetPackage(zipBytes.buffer),
    /duplicate assetId/
  );
});

test('parseWorksheetPackage rejects asset with byteLength mismatch', () => {
  const imgBytes = new Uint8Array([1, 2, 3]);
  const checksum = crc32(imgBytes).toString(16).padStart(8, '0');
  const zipBytes = createStoredZip([
    {
      path: 'manifest.json',
      data: JSON.stringify({
        format: PACKAGE_FORMAT,
        packageVersion: PACKAGE_VERSION,
        assets: [
          { assetId: 'img1', path: 'media/x.png', kind: 'image', usage: 'question_image', byteLength: 99, crc32: checksum },
        ],
      }),
    },
    { path: 'content/worksheet.json', data: JSON.stringify({ title: 'T', blocks: [] }) },
    { path: 'media/x.png', data: imgBytes },
  ]);
  assert.throws(
    () => parseWorksheetPackage(zipBytes.buffer),
    /byteLength mismatch/
  );
});

test('parseWorksheetPackage rejects asset with CRC32 mismatch', () => {
  const imgBytes = new Uint8Array([10, 20, 30]);
  const zipBytes = createStoredZip([
    {
      path: 'manifest.json',
      data: JSON.stringify({
        format: PACKAGE_FORMAT,
        packageVersion: PACKAGE_VERSION,
        assets: [
          { assetId: 'img2', path: 'media/y.png', kind: 'image', usage: 'question_image', byteLength: 3, crc32: 'deadbeef' },
        ],
      }),
    },
    { path: 'content/worksheet.json', data: JSON.stringify({ title: 'T', blocks: [] }) },
    { path: 'media/y.png', data: imgBytes },
  ]);
  assert.throws(
    () => parseWorksheetPackage(zipBytes.buffer),
    /CRC32 mismatch/
  );
});

test('normalizeAssetManifestList: assets with invalid path are silently filtered out', () => {
  const imgBytes = new Uint8Array([5]);
  const checksum = crc32(imgBytes).toString(16).padStart(8, '0');
  // Only the valid asset (path starts with media/) should survive
  const zipBytes = createStoredZip([
    {
      path: 'manifest.json',
      data: JSON.stringify({
        format: PACKAGE_FORMAT,
        packageVersion: PACKAGE_VERSION,
        assets: [
          { assetId: 'bad_path', path: 'content/worksheet.json', kind: 'image', usage: 'question_image', byteLength: 1, crc32: checksum },
          { assetId: 'dotdot', path: 'media/../etc/passwd', kind: 'image', usage: 'question_image', byteLength: 1, crc32: checksum },
          { assetId: 'valid', path: 'media/ok.png', kind: 'image', usage: 'question_image', byteLength: 1, crc32: checksum },
        ],
      }),
    },
    { path: 'content/worksheet.json', data: JSON.stringify({ title: 'T', blocks: [] }) },
    { path: 'media/ok.png', data: imgBytes },
  ]);
  const parsed = parseWorksheetPackage(zipBytes.buffer);
  assert.equal(parsed.assets.length, 1);
  assert.equal(parsed.assets[0].assetId, 'valid');
});
