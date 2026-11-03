import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAttemptName, attemptNameMode, currentAttemptName } from './attempt-menu.js';
import { assertAttemptPackage } from '../app/contracts/attempt-package-validator.js';

test('default name includes the optional student and fits the Unicode limit', () => {
  assert.equal(defaultAttemptName('Worksheet', ''), 'Worksheet');
  assert.equal(defaultAttemptName('Worksheet', '  Student  '), 'Worksheet — Student');
  const result = defaultAttemptName('😀'.repeat(100), '學'.repeat(120));
  assert.equal(Array.from(result).length, 80);
  assert.ok(result.startsWith('😀'));
  assert.ok(result.includes(' — '));
  assert.ok(!result.includes('\uFFFD'));
});
for (const allowLegacyEnvelope of [false, true]) {
  test(`optional metadata preserves old packages and rejects invalid known fields (legacy=${allowLegacyEnvelope})`, () => {
    const validate = metadata => assertAttemptPackage({ format: 'worksheet-attempt-package', packageVersion: 1 }, { blocks: [{ blockId: 'q' }] },
      { schemaVersion: 1, kind: 'worksheet-attempt', status: 'in_progress', answers: {}, ...(metadata === undefined ? {} : { metadata }) }, { allowLegacyEnvelope });
    validate(undefined);
    validate({ attemptNameMode: 'auto' });
    validate({ attemptNameMode: 'custom' });
    validate({ studentName: '', studentNameResolved: true, attemptName: 'Legacy '.repeat(50) });
    for (const metadata of [null, [], { attemptNameMode: 'invalid' }, { studentName: 1 }, { studentNameResolved: 'true' }, { attemptName: {} }]) assert.throws(() => validate(metadata));
  });
}

test('automatic names follow corrected and deliberately empty student names; custom edits persist', () => {
  const state = { viewerPayload: { title: 'Reading' }, studentName: 'Amy', attemptNameMode: 'auto', attemptNameDraft: 'Reading — Amy', savedAttemptName: 'Reading — Amy' };
  assert.equal(currentAttemptName(state), 'Reading — Amy');
  state.studentName = 'Ann';
  assert.equal(currentAttemptName(state), 'Reading — Ann');
  state.studentName = '';
  assert.equal(currentAttemptName(state), 'Reading');
  state.attemptNameMode = 'custom'; state.attemptNameDraft = 'My work';
  state.studentName = 'Ann';
  assert.equal(currentAttemptName(state), 'My work');
  state.attemptNameDraft = '';
  assert.equal(currentAttemptName(state), '', 'empty custom input must not silently reuse the saved name');
});
test('legacy names matching the suggestion remain automatic; other names are preserved', () => {
  assert.equal(attemptNameMode({}, 'Reading', 'Amy'), 'auto');
  assert.equal(attemptNameMode({ attemptNameDraft: 'Reading — Amy' }, 'Reading', 'Amy'), 'auto');
  assert.equal(attemptNameMode({ savedAttemptName: 'Reading — Amy (2)' }, 'Reading', 'Amy'), 'custom');
  assert.equal(attemptNameMode({ attemptNameMode: 'custom', attemptNameDraft: 'Reading — Amy' }, 'Reading', 'Amy'), 'custom');
});
