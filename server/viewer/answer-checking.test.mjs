import test from 'node:test';
import assert from 'node:assert/strict';
import * as mod from './answer-checking.js';

test('computeAnswerSummary counts only question blocks with non-empty answers', () => {
  const summary = mod.computeAnswerSummary(
    {
      blocks: [
        { blockId: 'c1', kind: 'content' },
        { blockId: 'q1', kind: 'question' },
        { blockId: 'q2', kind: 'question' },
      ],
    },
    {
      q1: { value: 'hello' },
      q2: { value: '' },
    }
  );
  assert.deepEqual(summary, { answered: 1, total: 2 });
});

test('computeAnswerSummary treats whitespace-only answers as unanswered', () => {
  const summary = mod.computeAnswerSummary(
    {
      blocks: [
        { blockId: 'q1', kind: 'question' },
        { blockId: 'q2', kind: 'question' },
        { blockId: 'q3', kind: 'question' },
      ],
    },
    {
      q1: { value: '   ' },
      q2: { value: '\t\n' },
      q3: { value: 'real answer' },
    }
  );
  assert.deepEqual(summary, { answered: 1, total: 3 });
});

test('computeAnswerSummary treats empty multi-select arrays as unanswered', () => {
  const summary = mod.computeAnswerSummary(
    {
      blocks: [
        { blockId: 'q1', kind: 'question' },
        { blockId: 'q2', kind: 'question' },
      ],
    },
    {
      q1: { value: [] },
      q2: { value: ['a'] },
    }
  );
  assert.deepEqual(summary, { answered: 1, total: 2 });
});

test('areMultiSelectValuesEqual normalizes, deduplicates, and compares membership without sort/join', () => {

  assert.equal(mod.areMultiSelectValuesEqual(['a', 2, 'a', 2], ['2', 'a']), true);
  assert.equal(mod.areMultiSelectValuesEqual(['a', 'b'], ['b', 'a', 'a']), true);
  assert.equal(mod.areMultiSelectValuesEqual(['a', 'b'], ['a']), false);
  assert.equal(mod.areMultiSelectValuesEqual('a', ['a']), false);
});

test('computeCheckResult uses set membership for multi-select grading', () => {

  const viewerPayload = {
    blocks: [
      {
        blockId: 'q1',
        kind: 'question',
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'multi',
          correctAnswer: ['b', 'a', 'a'],
        },
      },
    ],
  };

  const resultMatch = mod.computeCheckResult(viewerPayload, {
    q1: { value: ['a', 'b', 'a'] },
  });
  const resultMiss = mod.computeCheckResult(viewerPayload, {
    q1: { value: ['a'] },
  });

  assert.equal(resultMatch.byBlockId.q1, true);
  assert.equal(resultMatch.correctCount, 1);
  assert.equal(resultMiss.byBlockId.q1, false);
  assert.equal(resultMiss.correctCount, 0);
});

test('hasGradeableQuestions only returns true for question blocks with supported inputType and correctAnswer', () => {

  const noGradeable = {
    blocks: [
      { kind: 'content', blockId: 'c1' },
      { kind: 'question', blockId: 'q_text', responseConfig: { inputType: 'text', correctAnswer: 'x' } },
      { kind: 'question', blockId: 'q_unknown', responseConfig: { inputType: 'date', correctAnswer: '2026-01-01' } },
      { kind: 'question', blockId: 'q_missing', responseConfig: { inputType: 'number' } },
    ],
  };

  const hasGradeable = {
    blocks: [
      { kind: 'question', blockId: 'q_bool', responseConfig: { inputType: 'boolean', correctAnswer: true } },
    ],
  };

  assert.equal(mod.hasGradeableQuestions(noGradeable), false);
  assert.equal(mod.hasGradeableQuestions(hasGradeable), true);
});

test('computeCheckResult grades only supported input types with correctAnswer', () => {

  const viewerPayload = {
    blocks: [
      {
        blockId: 'q_multi',
        kind: 'question',
        responseConfig: { inputType: 'multiple_choice', selectionMode: 'multi', correctAnswer: ['a', 'b'] },
      },
      {
        blockId: 'q_bool',
        kind: 'question',
        responseConfig: { inputType: 'boolean', correctAnswer: true },
      },
      {
        blockId: 'q_number',
        kind: 'question',
        responseConfig: { inputType: 'number', correctAnswer: 3 },
      },
      {
        blockId: 'q_text',
        kind: 'question',
        responseConfig: { inputType: 'text', correctAnswer: 'hello' },
      },
      {
        blockId: 'q_unknown',
        kind: 'question',
        responseConfig: { inputType: 'date', correctAnswer: '2026-04-02' },
      },
      {
        blockId: 'q_missing',
        kind: 'question',
        responseConfig: { inputType: 'number' },
      },
    ],
  };

  const result = mod.computeCheckResult(viewerPayload, {
    q_multi: { value: ['b', 'a', 'a'] },
    q_bool: { value: true },
    q_number: { value: '3' },
    q_text: { value: 'hello' },
    q_unknown: { value: '2026-04-02' },
    q_missing: { value: 5 },
  });

  assert.deepEqual(Object.keys(result.byBlockId).sort(), ['q_bool', 'q_multi', 'q_number']);
  assert.deepEqual(result.statusByBlockId, {
    q_multi: 'correct',
    q_bool: 'correct',
    q_number: 'correct',
    q_missing: 'ungraded_missing_or_invalid_key',
  });
  assert.equal(result.correctCount, 3);
  assert.equal(result.totalQuestions, 3);
  assert.equal(Object.hasOwn(result, 'ungradedCount'), false);
});

test('computeCheckResult does not treat unanswered number input as 0 when correctAnswer is 0', () => {

  const viewerPayload = {
    blocks: [
      {
        blockId: 'q_number',
        kind: 'question',
        responseConfig: { inputType: 'number', correctAnswer: 0 },
      },
    ],
  };

  const resultEmpty = mod.computeCheckResult(viewerPayload, { q_number: { value: '' } });
  const resultNull = mod.computeCheckResult(viewerPayload, { q_number: { value: null } });
  const resultUndef = mod.computeCheckResult(viewerPayload, { q_number: { value: undefined } });
  const resultZero = mod.computeCheckResult(viewerPayload, { q_number: { value: '0' } });

  assert.equal(resultEmpty.byBlockId.q_number, false, 'empty string should not be correct');
  assert.equal(resultEmpty.correctCount, 0);
  assert.equal(resultNull.byBlockId.q_number, false, 'null should not be correct');
  assert.equal(resultNull.correctCount, 0);
  assert.equal(resultUndef.byBlockId.q_number, false, 'undefined should not be correct');
  assert.equal(resultUndef.correctCount, 0);
  assert.equal(resultZero.byBlockId.q_number, true, 'string "0" should be correct when correctAnswer is 0');
  assert.equal(resultZero.correctCount, 1);
});

test('computeCheckResult marks gradeable missing key questions as ungraded without changing summary fields', () => {

  const viewerPayload = {
    blocks: [
      {
        blockId: 'q_missing_key',
        kind: 'question',
        responseConfig: { inputType: 'number' },
      },
      {
        blockId: 'q_graded',
        kind: 'question',
        responseConfig: { inputType: 'boolean', correctAnswer: true },
      },
    ],
  };

  const result = mod.computeCheckResult(viewerPayload, {
    q_missing_key: { value: '12' },
    q_graded: { value: false },
  });

  assert.equal(result.byBlockId.q_missing_key, undefined);
  assert.equal(result.statusByBlockId.q_missing_key, 'ungraded_missing_or_invalid_key');
  assert.equal(result.statusByBlockId.q_graded, 'incorrect');
  assert.deepEqual(Object.keys(result).sort(), ['byBlockId', 'correctCount', 'statusByBlockId', 'totalQuestions']);
  assert.equal(result.correctCount, 0);
  assert.equal(result.totalQuestions, 1);
});

test('mixed blank scoring counts auto-checked blanks while completion requires every blank', () => {
  const blankConfig = {
    inputType: 'fill_in_blanks', mode: 'typed',
    passage: { version: 1, blocks: [{ tag: 'p', children: [
      { tag: 'blank', id: 'water', text: 'water', checking: 'auto', alternatives: ['rain water'] },
      { tag: 'blank', id: 'air', text: 'air', checking: 'auto', alternatives: [] },
      { tag: 'blank', id: 'reflection', text: '', checking: 'free', alternatives: [] },
    ] }] },
  };
  const payload = { blocks: [
    { kind: 'content', blockId: 'reading' },
    { kind: 'question', blockId: 'blanks', responseConfig: blankConfig },
    { kind: 'question', blockId: 'false', responseConfig: { inputType: 'boolean', correctAnswer: false } },
    { kind: 'question', blockId: 'zero', responseConfig: { inputType: 'number', correctAnswer: 0 } },
  ] };
  const answers = { blanks: { value: { water: ' RAIN WATER ', air: 'air' } }, false: { value: false }, zero: { value: 0 } };
  const before = structuredClone({ payload, answers });
  const result = mod.computeCheckResult(payload, answers);
  assert.equal(result.correctCount, 4);
  assert.equal(result.totalQuestions, 4);
  assert.deepEqual(result.blanksByBlockId.blanks.statuses, { water: 'correct', air: 'correct', reflection: 'teacher_review' });
  assert.equal(result.statusByBlockId.blanks, 'correct');
  assert.deepEqual(mod.computeAnswerSummary(payload, answers), { answered: 2, total: 3 });
  assert.deepEqual({ payload, answers }, before, 'calculations must not mutate worksheet or answers');
  answers.blanks.value.reflection = 'My thoughts';
  assert.deepEqual(mod.computeAnswerSummary(payload, answers), { answered: 3, total: 3 });
  assert.equal(mod.computeCheckResult(payload, answers).totalQuestions, 4);
});

test('free-only blanks require teacher review and word-bank blanks retain exact grading rules', () => {
  const blank = { tag: 'blank', id: 'a', text: 'Water', checking: 'free', alternatives: [] };
  const config = { inputType: 'fill_in_blanks', mode: 'typed', passage: { version: 1, blocks: [{ tag: 'p', children: [blank] }] } };
  const payload = { blocks: [{ kind: 'question', blockId: 'q', responseConfig: config }] };
  const answers = { q: { value: { a: 'water' } } };
  const free = mod.computeCheckResult(payload, answers);
  assert.equal(free.totalQuestions, 0);
  assert.equal(free.statusByBlockId.q, 'teacher_review');
  assert.equal(Object.hasOwn(free.byBlockId, 'q'), false);
  assert.equal(mod.hasGradeableQuestions(payload), false);
  assert.deepEqual(mod.computeAnswerSummary(payload, answers), { answered: 1, total: 1 });
  config.mode = 'word_bank';
  blank.checking = 'auto';
  assert.equal(mod.hasGradeableQuestions(payload), true);
  assert.equal(mod.computeCheckResult(payload, answers).correctCount, 1);
});

test('boolean checking preserves legacy learner values and rejects string answer keys', () => {
  const payload = { blocks: [{ kind: 'question', blockId: 'q', responseConfig: { inputType: 'boolean', correctAnswer: false } }] };
  for (const value of [false, 'false']) assert.equal(mod.computeCheckResult(payload, { q: { value } }).byBlockId.q, true);
  for (const value of [undefined, null, '', true, 'true']) assert.equal(mod.computeCheckResult(payload, { q: { value } }).byBlockId.q, false);
  payload.blocks[0].responseConfig.correctAnswer = 'false';
  assert.equal(mod.computeCheckResult(payload, { q: { value: false } }).statusByBlockId.q, 'ungraded_missing_or_invalid_key');
  assert.deepEqual(mod.computeCheckResult(null, {}), { byBlockId: {}, statusByBlockId: {}, correctCount: 0, totalQuestions: 0 });
});
