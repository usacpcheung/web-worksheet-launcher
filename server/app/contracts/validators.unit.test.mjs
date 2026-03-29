import test from 'node:test';
import assert from 'node:assert/strict';

import { validateDraftSchema } from './validators.js';

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
