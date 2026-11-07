import test from 'node:test';
import assert from 'node:assert/strict';
import { textConfigError, acceptsTextEdit, hasLongText } from './text-answer.js';
import { createWorksheetPackageFromDraft, parseWorksheetPackage } from '../editor/worksheet-package.js';
import { parseStoredZip, createStoredZip } from '../editor/zip-utils.js';
import { assertAttemptPackage } from './contracts/attempt-package-validator.js';
import { validateDraftSchema } from './contracts/validators.js';
const config = { inputType: 'text', textMode: 'long', maxLength: 20000, displayMode: 'multi_line' };
const blocks = [
  {
    blockId: 'q1',
    position: 0,
    kind: 'question',
    prompt: { text: 'Paste your conversation.' },
    responseConfig: config,
  },
];

test('text mode caps apply at contract boundaries while legacy configurations remain readable', () => {
  for (const [textMode, max, invalid] of [
    ['standard', 1200, 1201],
    ['long', 20000, 20001],
  ]) {
    assert.equal(textConfigError({ ...config, textMode, maxLength: max }), '');
    for (const maxLength of [0, -1, 2.5, invalid, '200'])
      assert.ok(textConfigError({ ...config, textMode, maxLength }));
  }
  assert.ok(textConfigError({ ...config, displayMode: 'single_line' }));
  assert.ok(textConfigError({ ...config, textMode: 'unknown' }));
  assert.equal(textConfigError({ inputType: 'text', maxLength: 4000 }), '');
  assert.ok(textConfigError({ inputType: 'text', maxLength: 4000 }, { authoring: true }));
  assert.equal(validateDraftSchema({ draftWorksheetId: 'draft', title: 'Long', blocks }).valid, true);
  assert.equal(
    validateDraftSchema({
      draftWorksheetId: 'draft',
      title: 'Bad',
      blocks: [{ ...blocks[0], responseConfig: { ...config, maxLength: 20001 } }],
    }).valid,
    false
  );
});

test('edit limits reject oversized additions and preserve partial repairs of legacy answers', () => {
  assert.equal(acceptsTextEdit('', '中'.repeat(20000), config), true);
  assert.equal(acceptsTextEdit('keep me', 'x'.repeat(20001), config), false);
  assert.equal(acceptsTextEdit('x'.repeat(21000), 'x'.repeat(20500), config), true);
  assert.equal(acceptsTextEdit('x'.repeat(21000), 'y'.repeat(21000), config), false);
  assert.equal(acceptsTextEdit('', '😀'.repeat(10000), config), true);
  assert.equal(acceptsTextEdit('', '😀'.repeat(10001), config), false);
});

test('long text worksheet packages round-trip with version 6 and reject downgraded versions', () => {
  const pkg = createWorksheetPackageFromDraft({ localId: 'draft', title: 'Long', blocks });
  const parsed = parseWorksheetPackage(pkg.bytes);
  assert.equal(parsed.manifest.packageVersion, 6);
  assert.deepEqual(parsed.worksheet.blocks[0].responseConfig, config);
  const files = parseStoredZip(pkg.bytes);
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  manifest.packageVersion = manifest.schemaVersion = 5;
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  const downgraded = createStoredZip([...files].map(([path, data]) => ({ path, data })));
  assert.throws(() => parseWorksheetPackage(downgraded), /version 6/);
});

test('long-text attempt envelope requires version 5 and continues to validate mixed image questions', () => {
  const worksheet = { blocks };
  const manifest = { format: 'worksheet-attempt-package', packageVersion: 5, schemaVersion: 1, assets: [] };
  const attempt = {
    schemaVersion: 1,
    kind: 'worksheet-attempt',
    status: 'in_progress',
    answers: { q1: { value: '  prompt\n\n' + '文'.repeat(19990) } },
  };
  assert.doesNotThrow(() => assertAttemptPackage(manifest, worksheet, attempt, { files: new Map() }));
  assert.throws(
    () => assertAttemptPackage({ ...manifest, packageVersion: 4 }, worksheet, attempt),
    /version 5/
  );
  const mixed = {
    blocks: [
      ...blocks,
      { blockId: 'image', kind: 'question', responseConfig: { inputType: 'image_response', maxImages: 3 } },
    ],
  };
  assert.equal(hasLongText(mixed.blocks), true);
  assert.doesNotThrow(() => assertAttemptPackage(manifest, mixed, attempt, { files: new Map() }));
  assert.throws(
    () =>
      assertAttemptPackage(
        manifest,
        mixed,
        { ...attempt, answers: { image: { value: [{ assetId: 'missing' }] } } },
        { files: new Map() }
      ),
    /image|Image/
  );
});

test('image budget reserves the full default long-text capacity when maxLength is omitted', async () => {
  const { imageBudget } = await import('./image-response.js');
  const implicit = [{ ...blocks[0], responseConfig: { inputType: 'text', textMode: 'long' } }];
  assert.equal(imageBudget(implicit, 0).total, imageBudget(blocks, 0).total);
});
