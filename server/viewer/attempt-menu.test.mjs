import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAttemptName } from './attempt-menu.js';
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
    validate({ studentName: '', studentNameResolved: true, attemptName: 'Legacy '.repeat(50) });
    for (const metadata of [null, [], { studentName: 1 }, { studentNameResolved: 'true' }, { attemptName: {} }]) assert.throws(() => validate(metadata));
  });
}
