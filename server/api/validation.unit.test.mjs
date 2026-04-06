import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUuid, parseOptionalNonNegativeInt } from './validation.js';

test('assertUuid returns structured error for malformed UUID', () => {
  const result = assertUuid('bad', { code: 'INVALID_ID', message: 'id must be uuid' });
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'INVALID_ID',
      message: 'id must be uuid',
    },
  });
});

test('parseOptionalNonNegativeInt validates non-negative integers', () => {
  const result = parseOptionalNonNegativeInt('-1', { field: 'limit', max: 100, defaultValue: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_QUERY_PARAM');
});
