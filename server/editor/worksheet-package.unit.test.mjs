import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorksheetPackageFromDraft,
  mapLegacyJsonToPackageModel,
  parseWorksheetPackage,
} from './worksheet-package.js';

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
