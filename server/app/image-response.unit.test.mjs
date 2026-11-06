import test from 'node:test';
import assert from 'node:assert/strict';
import {
  imageHeader,
  assertImageQuestions,
  imageBudget,
  assertImageAnswers,
  IMAGE_ANSWER_BYTES,
} from './image-response.js';
import { createWorksheetPackageFromDraft, parseWorksheetPackage } from '../editor/worksheet-package.js';
import { assertAttemptPackage } from './contracts/attempt-package-validator.js';
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64'
  )
);
const block = {
  blockId: 'q',
  kind: 'question',
  prompt: { text: 'Draw' },
  responseConfig: { inputType: 'image_response', maxImages: 3 },
};
test('question limits and package versions preserve image-response configuration', () => {
  const draft = { localId: 'd', title: 'Drawing', blocks: [block], assets: [] };
  const result = createWorksheetPackageFromDraft(draft);
  assert.equal(result.manifest.packageVersion, 5);
  assert.equal(parseWorksheetPackage(result.bytes).worksheet.blocks[0].responseConfig.maxImages, 3);
  assert.throws(() => assertImageQuestions(Array(4).fill(block)), /at most 3/);
  for (const maxImages of [0, 4, 1.5, '3'])
    assert.throws(() =>
      assertImageQuestions([
        {
          ...block,
          responseConfig: { inputType: 'image_response', maxImages },
        },
      ])
    );
  assert.throws(() => assertImageQuestions([{ ...block, kind: 'content' }]));
});
test('budget reserves configured counts plus overhead and rejects large worksheets', () => {
  assert.equal(imageBudget([block], 0).reserved, 3 * IMAGE_ANSWER_BYTES);
  assert.equal(imageBudget(Array(3).fill(block), 12 * 1048576).ok, false);
  assert.equal(imageBudget(Array(3).fill(block), 10 * 1048576).ok, true);
});
test('headers reject oversized dimensions, truncated images, animated PNG and non-images', () => {
  assert.deepEqual(imageHeader(png), {
    width: 1,
    height: 1,
    mime: 'image/png',
  });
  const huge = png.slice();
  new DataView(huge.buffer).setUint32(16, 9000);
  assert.throws(() => imageHeader(huge), /dimensions/);
  assert.throws(() => imageHeader(png.slice(0, 30)));
  assert.throws(() => imageHeader(new Uint8Array([1, 2, 3])));
  const animated = png.slice();
  new DataView(animated.buffer).setUint32(37, 0x6163544c);
  assert.throws(() => imageHeader(animated), /Animated/);
});
test('attempt validation requires all image references and bytes, even with legacy envelope option', () => {
  const asset = {
    assetId: 'a',
    path: 'media/a',
    mimeType: 'image/png',
    byteLength: png.length,
  };
  const files = new Map([['media/a', png]]),
    assets = new Map([['a', asset]]),
    answers = { q: { value: [{ assetId: 'a' }] } };
  assert.doesNotThrow(() => assertImageAnswers([block], answers, assets, files));
  assert.throws(() => assertImageAnswers([block], { q: { value: [{ assetId: 'missing' }] } }, assets, files));
  assert.throws(() =>
    assertImageAnswers([block], { q: { value: [{ assetId: 'a' }, { assetId: 'a' }] } }, assets, files)
  );
  assert.throws(() =>
    assertImageAnswers([block], answers, new Map([['a', { ...asset, mimeType: 'image/jpeg' }]]), files)
  );
  const manifest = {
    format: 'worksheet-attempt-package',
    packageVersion: 4,
    assets: [asset],
  };
  assert.doesNotThrow(() =>
    assertAttemptPackage(
      manifest,
      { blocks: [block] },
      { schemaVersion: 1, kind: 'worksheet-attempt', status: 'in_progress', answers },
      { allowLegacyEnvelope: true, files }
    )
  );
  assert.throws(
    () =>
      assertAttemptPackage(
        { ...manifest, packageVersion: 3 },
        { blocks: [block] },
        { schemaVersion: 1, kind: 'worksheet-attempt', status: 'in_progress', answers },
        { allowLegacyEnvelope: true, files }
      ),
    /version 4/
  );
});

test('image responses coexist with MC images and enforce text-answer budget', () => {
  const mc = {
    blockId: 'choice',
    kind: 'question',
    prompt: { text: 'Choose' },
    responseConfig: {
      inputType: 'multiple_choice',
      selectionMode: 'single',
      options: [{ id: 'a', value: 'a', label: '', mediaRefs: [{ usage: 'option_image', assetId: 'image' }] }],
    },
  };
  const asset = {
    assetId: 'image',
    kind: 'image',
    usage: 'option_image',
    mimeType: 'image/png',
    path: 'media/image',
  };
  const packed = createWorksheetPackageFromDraft(
    { localId: 'mixed', title: 'Mixed', blocks: [block, mc], assets: [asset] },
    new Map([['image', { binary: png }]])
  );
  const parsed = parseWorksheetPackage(packed.bytes);
  assert.equal(parsed.worksheet.blocks[1].responseConfig.options[0].mediaRefs[0].assetId, 'image');
  assert.equal(parsed.assets[0].binary.length, png.length);
  const text = { kind: 'question', responseConfig: { inputType: 'text', maxLength: 2_000_000 } };
  assert.equal(imageBudget([block, text], 15 * 1048576).ok, false);
  assert.equal(
    imageBudget([block, { ...text, responseConfig: { inputType: 'text', maxLength: 0 } }], 0).ok,
    false
  );
  assert.throws(
    () =>
      assertAttemptPackage(
        { format: 'worksheet-attempt-package', packageVersion: 4, assets: [] },
        { blocks: [block] },
        { answers: {} },
        { allowLegacyEnvelope: true, files: new Map() }
      ),
    /schema/
  );
});

test('Chinese worksheet budget counts UTF-8 bytes consistently on export and import', () => {
  const drawing = { ...block, prompt: { text: '畫圖'.repeat(4000) } };
  const media = new Uint8Array(22 * 1048576);
  const draft = {
    localId: 'zh-budget',
    title: '圖畫',
    blocks: [drawing],
    assets: [{ assetId: 'prompt', kind: 'image', usage: 'question_image', mimeType: 'image/png' }],
  };
  const packed = createWorksheetPackageFromDraft(draft, new Map([['prompt', { binary: media }]]));
  assert.doesNotThrow(() => parseWorksheetPackage(packed.bytes));
});
