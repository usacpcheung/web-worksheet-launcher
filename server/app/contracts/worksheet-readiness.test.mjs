import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorksheetReadiness } from './worksheet-readiness.js';
import { validateViewerPayloadSchema } from './validators.js';
import { createWorksheetPackageFromDraft, parseWorksheetPackage } from '../../editor/worksheet-package.js';
import { emptyBlankConfig } from '../fill-in-blanks.js';

const question = config => ({ blockId: 'q', kind: 'question', position: 0, prompt: { text: 'Question' }, responseConfig: config });
const draft = blocks => ({ localId: 'fixture', title: 'Validation fixture', blocks });
const cases = [
  ['no blocks', []],
  ['empty reading', [{ blockId: 'c', kind: 'content', position: 0, content: { text: ' \n ' } }]],
  ['empty prompt', [{ ...question({ inputType: 'text' }), prompt: { text: ' \n ' } }]],
  ['unsupported type', [question({ inputType: 'unsupported' })]],
  ['empty choices', [question({ inputType: 'multiple_choice', options: [] })]],
  ['blank choice', [question({ inputType: 'multiple_choice', options: [{ value: 'a', label: '' }] })]],
  ['duplicate choices', [question({ inputType: 'multiple_choice', options: ['a', 'a'] })]],
  ['space-only choice differences', [question({ inputType: 'multiple_choice', options: ['a', ' a '] })]],
  ['wrong choice key', [question({ inputType: 'multiple_choice', options: ['a'], correctAnswer: 'b' })]],
  ['wrong boolean key', [question({ inputType: 'boolean', correctAnswer: 'yes' })]],
  ['reversed range', [question({ inputType: 'number', min: 10, max: 1 })]],
  ['out-of-range key', [question({ inputType: 'number', min: 10, correctAnswer: 1 })]],
  ['invalid decimal rule', [question({ inputType: 'number', numberRules: { decimalPlacesAllowed: -1 } })]],
  ['short text too long', [question({ inputType: 'text', textMode: 'standard', maxLength: 1201 })]],
  ['long text too long', [question({ inputType: 'text', textMode: 'long', maxLength: 20001 })]],
  ['incomplete blanks', [question(emptyBlankConfig())]],
  ['image count', [question({ inputType: 'image_response', maxImages: 4 })]],
  ['duplicate block IDs', [question({ inputType: 'text' }), { ...question({ inputType: 'boolean' }), position: 1 }]],
];
for (const [name, blocks] of cases) test(`distribution blocks ${name} before making a ZIP`, () => {
  const worksheet = draft(blocks);
  assert.equal(validateWorksheetReadiness(worksheet, { authoring: true }).valid, false);
  assert.throws(() => createWorksheetPackageFromDraft(worksheet));
});

test('invalid feedback is blocked even with otherwise valid questions', () => {
  const worksheet = { ...draft([question({ inputType: 'text' })]), feedback: { enabled: true } };
  assert.equal(validateWorksheetReadiness(worksheet).valid, false);
  assert.throws(() => createWorksheetPackageFromDraft(worksheet), /feedback/);
});

test('valid optional answer keys, free blanks, long prompts and both text modes remain usable', () => {
  const free = emptyBlankConfig();
  free.passage.blocks[0].children.push({ tag: 'blank', id: 'b', text: '', alternatives: [], checking: 'free' });
  for (const config of [
    { inputType: 'text', maxLength: 1200 },
    { inputType: 'text', textMode: 'long', maxLength: 20000 },
    { inputType: 'number' }, { inputType: 'boolean' },
    { inputType: 'multiple_choice', options: ['A', 'B'] }, free,
  ]) {
    const block = question(config);
    block.prompt.text = config.inputType === 'fill_in_blanks' ? '' : 'Long prompt '.repeat(100);
    const worksheet = draft([block]);
    assert.equal(validateWorksheetReadiness(worksheet, { authoring: true }).valid, true);
    const parsed = parseWorksheetPackage(createWorksheetPackageFromDraft(worksheet).bytes);
    const reader = validateViewerPayloadSchema({ ...parsed.worksheet, worksheetId: 'w', snapshotId: 's' });
    assert.equal(reader.valid, true, reader.errors.join('; '));
  }
});

test('legacy text limit remains readable but requires correction for new authoring', () => {
  const worksheet = draft([question({ inputType: 'text', maxLength: 2000 })]);
  assert.equal(validateWorksheetReadiness(worksheet).valid, true);
  assert.equal(validateWorksheetReadiness(worksheet, { authoring: true }).valid, false);
});

test('missing audio cannot produce a package that fails the parser', () => {
  const worksheet = draft([question({ inputType: 'text' })]);
  worksheet.blocks[0].prompt.audioTracks = [{ language: 'english', assetId: 'missing', sourceTextHash: 'hash' }];
  assert.throws(() => createWorksheetPackageFromDraft(worksheet), /does not exist/);
});
