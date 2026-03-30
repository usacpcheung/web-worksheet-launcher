import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateDraftSchema,
  validateSnapshotSchema,
  validateViewerPayloadSchema,
} from './validators.js';

function createDraftWithQuestionResponseConfig(responseConfig) {
  return {
    draftWorksheetId: 'draft_1',
    title: 'Worksheet',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q1', format: 'plain_text' },
        responseConfig,
      },
    ],
  };
}

function createSnapshotWithQuestionResponseConfig(responseConfig) {
  return {
    worksheetId: 'ws_1',
    snapshotId: 'snap_1',
    draftWorksheetId: 'draft_1',
    title: 'Worksheet',
    sourceDraftRevision: 'rev_1',
    schemaVersion: 1,
    snapshotVersion: 1,
    publishedAt: '2026-01-01T00:00:00.000Z',
    publishedByUserId: 'teacher_1',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q1', format: 'plain_text' },
        responseConfig,
      },
    ],
  };
}

function createViewerPayloadWithQuestionResponseConfig(responseConfig) {
  return {
    worksheetId: 'ws_1',
    snapshotId: 'snap_1',
    snapshotVersion: 1,
    title: 'Worksheet',
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        position: 0,
        prompt: { text: 'Q1', format: 'plain_text' },
        responseConfig,
      },
    ],
  };
}

test('validateDraftSchema allows missing correctAnswer for backward compatibility', () => {
  const result = validateDraftSchema(createDraftWithQuestionResponseConfig({ inputType: 'text', maxLength: 200 }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateDraftSchema enforces boolean and number correctAnswer types', () => {
  const badBoolean = validateDraftSchema(createDraftWithQuestionResponseConfig({ inputType: 'boolean', correctAnswer: 'true' }));
  assert.equal(badBoolean.valid, false);
  assert.equal(
    badBoolean.errors.includes('draft.blocks[0].responseConfig.correctAnswer must be a boolean for boolean inputType'),
    true
  );

  const goodNumber = validateDraftSchema(createDraftWithQuestionResponseConfig({ inputType: 'number', correctAnswer: 3.5 }));
  assert.equal(goodNumber.valid, true);
});

test('validateDraftSchema enforces multiple_choice answer membership and uniqueness', () => {
  const single = validateDraftSchema(createDraftWithQuestionResponseConfig({
    inputType: 'multiple_choice',
    selectionMode: 'single',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    correctAnswer: 'z',
  }));
  assert.equal(single.valid, false);
  assert.equal(
    single.errors.includes('draft.blocks[0].responseConfig.correctAnswer must match an existing options[*].value for multiple_choice single mode'),
    true
  );

  const multi = validateDraftSchema(createDraftWithQuestionResponseConfig({
    inputType: 'multiple_choice',
    selectionMode: 'multi',
    options: [{ label: 'A' }, { label: 'B' }],
    correctAnswer: ['A', 'A', 'C'],
  }));
  assert.equal(multi.valid, false);
  assert.equal(
    multi.errors.includes('draft.blocks[0].responseConfig.correctAnswer[1] must be unique for multiple_choice multi mode'),
    true
  );
  assert.equal(
    multi.errors.includes('draft.blocks[0].responseConfig.correctAnswer[2] must match an existing options[*].value for multiple_choice multi mode'),
    true
  );
});

test('validateDraftSchema does not allow synthetic option_${index} membership for malformed options', () => {
  const single = validateDraftSchema(createDraftWithQuestionResponseConfig({
    inputType: 'multiple_choice',
    selectionMode: 'single',
    options: [null],
    correctAnswer: 'option_0',
  }));
  assert.equal(single.valid, false);
  assert.equal(
    single.errors.includes('draft.blocks[0].responseConfig.correctAnswer must match an existing options[*].value for multiple_choice single mode'),
    true
  );
});

test('validateDraftSchema validates numberRules shape for number inputType', () => {
  const valid = validateDraftSchema(createDraftWithQuestionResponseConfig({
    inputType: 'number',
    numberRules: {
      allowedKinds: ['integer', 'decimal'],
      allowSigned: false,
      decimalPlacesAllowed: 2,
    },
  }));
  assert.equal(valid.valid, true);

  const invalidAllowedKinds = validateDraftSchema(createDraftWithQuestionResponseConfig({
    inputType: 'number',
    numberRules: { allowedKinds: ['fraction'] },
  }));
  assert.equal(invalidAllowedKinds.valid, false);
  assert.equal(
    invalidAllowedKinds.errors.includes('draft.blocks[0].responseConfig.numberRules.allowedKinds contains unsupported values'),
    true
  );

  const emptyAllowedKinds = validateDraftSchema(createDraftWithQuestionResponseConfig({
    inputType: 'number',
    numberRules: { allowedKinds: [] },
  }));
  assert.equal(emptyAllowedKinds.valid, false);
  assert.equal(
    emptyAllowedKinds.errors.includes('draft.blocks[0].responseConfig.numberRules.allowedKinds must be a non-empty array when provided'),
    true
  );

  const invalidDecimalPlaces = validateDraftSchema(createDraftWithQuestionResponseConfig({
    inputType: 'number',
    numberRules: { decimalPlacesAllowed: -1 },
  }));
  assert.equal(invalidDecimalPlaces.valid, false);
  assert.equal(
    invalidDecimalPlaces.errors.includes('draft.blocks[0].responseConfig.numberRules.decimalPlacesAllowed must be an integer >= 0 or null'),
    true
  );
});

test('validateDraftSchema rejects numberRules on non-number inputs', () => {
  const result = validateDraftSchema(createDraftWithQuestionResponseConfig({
    inputType: 'text',
    numberRules: { allowSigned: false },
  }));
  assert.equal(result.valid, false);
  assert.equal(
    result.errors.includes('draft.blocks[0].responseConfig.numberRules is only supported for number inputType'),
    true
  );
});

test('number correctAnswer semantic checks pass/fail across draft/snapshot/viewer validators', () => {
  const makeNumberConfig = (overrides = {}) => ({
    inputType: 'number',
    numberRules: {
      allowedKinds: ['integer'],
      allowSigned: false,
      decimalPlacesAllowed: 0,
    },
    min: 1,
    max: 5,
    correctAnswer: 3,
    ...overrides,
  });

  const validators = [
    { validate: validateDraftSchema, makePayload: createDraftWithQuestionResponseConfig, path: 'draft' },
    { validate: validateSnapshotSchema, makePayload: createSnapshotWithQuestionResponseConfig, path: 'snapshot' },
    { validate: validateViewerPayloadSchema, makePayload: createViewerPayloadWithQuestionResponseConfig, path: 'viewerPayload' },
  ];

  validators.forEach(({ validate, makePayload, path }) => {
    const valid = validate(makePayload(makeNumberConfig()));
    assert.equal(valid.valid, true, `${path} should accept a compliant number correctAnswer`);

    const signedDisallowed = validate(makePayload(makeNumberConfig({ correctAnswer: -2 })));
    assert.equal(signedDisallowed.valid, false);
    assert.equal(
      signedDisallowed.errors.includes(
        `${path}.blocks[0].responseConfig.correctAnswer violates numberRules or min/max constraints for number inputType`
      ),
      true
    );

    const kindNotAllowed = validate(makePayload(makeNumberConfig({ correctAnswer: 2.5 })));
    assert.equal(kindNotAllowed.valid, false);
    assert.equal(
      kindNotAllowed.errors.includes(
        `${path}.blocks[0].responseConfig.correctAnswer violates numberRules or min/max constraints for number inputType`
      ),
      true
    );

    const integerInDecimalAllowed = validate(makePayload(makeNumberConfig({
      numberRules: {
        allowedKinds: ['decimal'],
        allowSigned: true,
      },
      min: undefined,
      max: undefined,
      correctAnswer: 2,
    })));
    assert.equal(
      integerInDecimalAllowed.valid,
      true,
      `${path} should accept an integer-valued correctAnswer when allowedKinds includes decimal`
    );

    const decimalPlacesExceeded = validate(makePayload(makeNumberConfig({
      numberRules: {
        allowedKinds: ['decimal'],
        allowSigned: true,
        decimalPlacesAllowed: 2,
      },
      min: undefined,
      max: undefined,
      correctAnswer: 2.345,
    })));
    assert.equal(decimalPlacesExceeded.valid, false);
    assert.equal(
      decimalPlacesExceeded.errors.includes(
        `${path}.blocks[0].responseConfig.correctAnswer violates numberRules or min/max constraints for number inputType`
      ),
      true
    );

    const belowMin = validate(makePayload(makeNumberConfig({ correctAnswer: 0 })));
    assert.equal(belowMin.valid, false);
    assert.equal(
      belowMin.errors.includes(
        `${path}.blocks[0].responseConfig.correctAnswer violates numberRules or min/max constraints for number inputType`
      ),
      true
    );

    const aboveMax = validate(makePayload(makeNumberConfig({ correctAnswer: 10 })));
    assert.equal(aboveMax.valid, false);
    assert.equal(
      aboveMax.errors.includes(
        `${path}.blocks[0].responseConfig.correctAnswer violates numberRules or min/max constraints for number inputType`
      ),
      true
    );
  });
});
