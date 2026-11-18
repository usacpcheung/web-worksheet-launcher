import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionConfigHelpers } from './question-config.js';

function helpers(overrides = {}) {
  let nextId = 0;
  return createQuestionConfigHelpers({
    createLocalId: prefix => `${prefix}_${++nextId}`,
    // The real editor media normalizer is exercised by session/package tests.
    normalizeMediaRefs: refs => Array.isArray(refs) ? refs : [],
    ...overrides,
  });
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('helpers import without a DOM and pasted options use the supplied ID generator', () => {
  assert.equal(typeof document, 'undefined');
  const config = helpers();
  assert.deepEqual(config.mapOptionsTextToLines(' A\r\n\n B\r C '), ['A', 'B', 'C']);
  assert.deepEqual(config.mapOptionsTextToResponseOptions(' A\n\n B '), [
    { id: 'opt_1', value: 'A', label: 'A' },
    { id: 'opt_2', value: 'B', label: 'B' },
  ]);
  assert.deepEqual(config.mapOptionsTextToResponseOptions(null), []);
});

test('text defaults, long mode and legacy finite lengths retain existing normalization', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  for (const input of [undefined, null, [], 'text']) {
    assert.deepEqual(normalize(input), { inputType: 'text', maxLength: 200, displayMode: 'multi_line' });
  }
  assert.deepEqual(normalize({ inputType: 'text', textMode: 'long', displayMode: 'single_line' }), {
    inputType: 'text', textMode: 'long', maxLength: 20000, displayMode: 'multi_line',
  });
  assert.equal(normalize({ inputType: 'text', maxLength: 4096 }).maxLength, 4096);
  assert.equal(normalize({ inputType: 'text', maxLength: '500' }).maxLength, 200);
  assert.equal(normalize({ inputType: 'text', maxLength: 0 }).maxLength, 0, 'validation, not normalization, rejects this');
  assert.equal(normalize({ inputType: 'text', displayMode: 'single_line' }).displayMode, 'single_line');
});

test('boolean false and numeric zero survive without coercing string answers', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  assert.deepEqual(normalize({ inputType: 'boolean', correctAnswer: false, maxLength: 200, options: [] }), {
    inputType: 'boolean', correctAnswer: false,
  });
  assert.equal(Object.hasOwn(normalize({ inputType: 'boolean', correctAnswer: 'false' }), 'correctAnswer'), false);
  const number = normalize({ inputType: 'number', min: 0, max: 10, correctAnswer: 0 });
  assert.equal(number.correctAnswer, 0);
  assert.deepEqual(number.numberRules, { allowedKinds: ['integer', 'decimal'], allowSigned: true, decimalPlacesAllowed: null });
  assert.equal(Object.hasOwn(normalize({ inputType: 'number', correctAnswer: '0' }), 'correctAnswer'), false);
});

test('numeric rules preserve fallback kinds and remove incompatible stored correct answers', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  assert.deepEqual(normalize({ inputType: 'number', numberRules: { allowedKinds: ['bad'], decimalPlacesAllowed: -1 } }).numberRules, {
    allowedKinds: ['integer', 'decimal'], allowSigned: true, decimalPlacesAllowed: null,
  });
  for (const input of [
    { min: 5, correctAnswer: 4 },
    { max: 5, correctAnswer: 6 },
    { numberRules: { allowSigned: false }, correctAnswer: -1 },
    { numberRules: { allowedKinds: ['integer'] }, correctAnswer: 1.5 },
    { numberRules: { decimalPlacesAllowed: 1 }, correctAnswer: 1.25 },
  ]) assert.equal(Object.hasOwn(normalize({ inputType: 'number', ...input }), 'correctAnswer'), false);
});

const noErrors = { min: null, max: null, decimalPlacesAllowed: null, correctAnswer: null };
for (const [name, config, raw, expected] of [
  ['invalid range suppresses answer range errors', { min: 10, max: 5 }, { correctAnswer: '7' }, {
    min: 'Max must be greater than or equal to Min', max: 'Max must be greater than or equal to Min',
  }],
  ['invalid decimal rule suppresses precision errors', {}, { decimalPlacesAllowed: '1.5', correctAnswer: '1.234' }, {
    decimalPlacesAllowed: 'Decimal places allowed must be a non-negative integer',
  }],
  ['blank decimal rule removes precision constraint', { numberRules: { decimalPlacesAllowed: 1 } }, { decimalPlacesAllowed: '', correctAnswer: '1.234' }, {}],
  ['blank answer stays optional', {}, { correctAnswer: '' }, {}],
  ['non-numeric raw answer', {}, { correctAnswer: 'abc' }, { correctAnswer: 'Correct answer must be a valid number' }],
  ['signed answer', { numberRules: { allowSigned: false } }, { correctAnswer: '-1' }, { correctAnswer: 'Correct answer must be positive when signed values are disabled' }],
  ['scientific notation precision', {}, { decimalPlacesAllowed: '6', correctAnswer: '1e-7' }, { correctAnswer: 'Correct answer has more decimal places than allowed' }],
  ['scientific notation integer', {}, { decimalPlacesAllowed: '0', correctAnswer: '1e+7' }, {}],
  ['raw out-of-range answer', { max: 5 }, { correctAnswer: '6' }, { correctAnswer: 'Correct answer must be less than or equal to Max' }],
]) test(`number validation: ${name}`, () => {
  assert.deepEqual(helpers().getNumberQuestionValidationErrors(config, raw), { ...noErrors, ...expected });
});

test('existing option IDs and media associations remain stable without mutating input', () => {
  const mediaRefs = [
    { usage: 'option_image', assetId: 'photo' },
    { usage: 'option_audio', assetId: 'legacy-audio' },
    { usage: 'question_image', assetId: 'prompt-photo' },
  ];
  const audioTracks = [{ language: 'english', assetId: 'en-audio', sourceTextHash: 'hash', voicePresetId: 'english' }];
  const input = freeze({ id: 'image-option', value: '', label: '', imageDescription: 'Photo', mediaRefs, audioTracks });
  let delegated;
  const { normalizeResponseOption } = helpers({
    createLocalId: () => assert.fail('valid IDs must not be regenerated'),
    normalizeMediaRefs: refs => { delegated = refs; return refs; },
  });
  const option = normalizeResponseOption(input);
  assert.equal(delegated, mediaRefs);
  assert.deepEqual(option, { ...input, value: 'image-option', mediaRefs: mediaRefs.slice(0, 2) });
  assert.equal(input.value, '');
});

test('single MC prefers a valid option ID over a stale legacy value and follows reorder', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  const input = freeze({ inputType: 'multiple_choice', options: [
    { id: 'a', value: 'A' }, { id: 'b', value: 'B' },
  ], correctAnswerOptionId: 'b', correctAnswer: 'A' });
  const normalized = normalize(input);
  assert.equal(normalized.correctAnswerOptionId, 'b');
  assert.equal(normalized.correctAnswer, 'B');
  assert.equal(normalize({ ...normalized, options: [...normalized.options].reverse() }).correctAnswer, 'B');
  const deleted = normalize({ ...normalized, options: normalized.options.filter(option => option.id !== 'b') });
  assert.equal(Object.hasOwn(deleted, 'correctAnswerOptionId'), false);
  assert.equal(Object.hasOwn(deleted, 'correctAnswer'), false);
});

test('legacy duplicate MC values consume distinct IDs and retain the ambiguity warning', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  const input = freeze({ inputType: 'multiple_choice', selectionMode: 'multi',
    options: [{ id: 'a', value: 'water' }, { id: 'b', value: 'water' }],
    correctAnswer: ['water', 'water', 'missing'],
  });
  const normalized = normalize(input);
  assert.deepEqual(normalized.correctAnswerOptionIds, ['a', 'b']);
  assert.deepEqual(normalized.correctAnswer, ['water', 'water']);
  assert.equal(normalized.correctAnswerMappingWarning, 'Ambiguous value-to-option mapping for duplicate values: water.');
  const contract = normalize(input, { forContract: true });
  assert.deepEqual(contract.options, [{ value: 'water', label: 'water' }, { value: 'water', label: 'water' }]);
  for (const key of ['correctAnswerOptionId', 'correctAnswerOptionIds', 'correctAnswerMappingWarning']) {
    assert.equal(Object.hasOwn(contract, key), false);
  }
  assert.deepEqual(contract.correctAnswer, ['water', 'water']);
});

test('multi MC deduplicates valid IDs and ignores stale IDs while retaining answer order', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  const result = normalize({ inputType: 'multiple_choice', selectionMode: 'multi',
    options: [{ id: 'a', value: 'A' }, { id: 'b', value: 'B' }],
    correctAnswerOptionIds: ['b', 'b', 'missing', 'a'], correctAnswer: ['A'],
  });
  assert.deepEqual(result.correctAnswerOptionIds, ['b', 'a']);
  assert.deepEqual(result.correctAnswer, ['B', 'A']);
});

test('legacy primitive MC options keep string answer semantics', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  const result = normalize({ inputType: 'multiple_choice', selectionMode: 'multi', options: [false, 0, 'C'], correctAnswer: ['false', '0'] });
  assert.deepEqual(result.correctAnswerOptionIds, ['opt_1', 'opt_2']);
  assert.deepEqual(result.correctAnswer, ['false', '0']);
});

test('duplicate detection trims values and ignores empty choices', () => {
  assert.deepEqual(helpers().getDuplicateOptionValues([' A ', 'A', '', 'B', 'B']), ['A', 'B']);
});

test('contract image options retain image identity while editor-only audio stays out of contract projection', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  const input = freeze({ inputType: 'multiple_choice', options: [{ id: 'picture', value: '', label: '',
    mediaRefs: [{ usage: 'option_image', assetId: 'photo' }, { usage: 'option_audio', assetId: 'sound' }],
    audioTracks: [{ language: 'english', assetId: 'audio', sourceTextHash: 'hash', voicePresetId: 'english' }],
  }], correctAnswerOptionId: 'picture' });
  const editor = normalize(input);
  assert.equal(editor.options[0].audioTracks.length, 1);
  const contract = normalize(input, { forContract: true });
  assert.deepEqual(contract.options, [{ id: 'picture', value: 'picture', label: '',
    mediaRefs: [{ usage: 'option_image', assetId: 'photo' }], imageDescription: '',
  }]);
  assert.equal(contract.correctAnswer, 'picture');
  assert.equal(Object.hasOwn(contract, 'correctAnswerOptionId'), false);
});

test('fill-in-blanks clones authored passage, modes and bank settings; missing passage retains defaults', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  const input = freeze({ inputType: 'fill_in_blanks', mode: 'word_bank', reuseWords: false, distractors: ['stone'],
    passage: { version: 1, blocks: [{ tag: 'p', children: [{ tag: 'blank', id: 'b1', text: 'water', checking: 'auto', alternatives: ['Water'] }] }] },
  });
  for (const forContract of [false, true]) {
    const result = normalize(input, { forContract });
    assert.deepEqual(result, input);
    assert.notEqual(result.passage, input.passage);
  }
  assert.deepEqual(normalize({ inputType: 'fill_in_blanks' }), {
    inputType: 'fill_in_blanks', mode: 'typed', reuseWords: false, distractors: [],
    passage: { version: 1, blocks: [{ tag: 'p', children: [] }] },
  });
});

test('image and unknown types retain current projection rather than adding validation', () => {
  const { normalizeQuestionResponseConfig: normalize } = helpers();
  assert.deepEqual(normalize({ inputType: 'image_response', maxLength: 200, options: [] }), { inputType: 'image_response', maxImages: 3 });
  assert.deepEqual(normalize({ inputType: 'image_response', maxImages: 0 }), { inputType: 'image_response', maxImages: 0 });
  assert.deepEqual(normalize({ inputType: 'future', extra: 1, maxLength: 200, options: [], correctAnswer: 'A' }), { inputType: 'future', extra: 1 });
});
