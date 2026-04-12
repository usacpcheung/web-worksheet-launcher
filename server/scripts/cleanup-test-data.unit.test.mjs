import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

test('cleanup script escapes LIKE metacharacters and uses ESCAPE clause', async () => {
  const source = await fs.readFile(path.resolve('scripts/cleanup-test-data.sh'), 'utf8');
  assert.equal(source.includes("OWNER_PREFIX_LIKE_SQL=$(printf \"%s\" \"$OWNER_PREFIX\" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/%/\\\\%/g' -e 's/_/\\\\_/g' -e \"s/'/''/g\")"), true);
  assert.equal(source.includes("LIKE '${OWNER_PREFIX_LIKE_SQL}%' ESCAPE '\\'"), true);
});

test('cleanup script normalizes storage root once and protects rm from option-injection', async () => {
  const source = await fs.readFile(path.resolve('scripts/cleanup-test-data.sh'), 'utf8');
  assert.equal(source.includes('normalized_root=$(realpath -m "$STORAGE_ROOT")'), true);
  assert.equal(source.includes('if rm -f -- "$normalized_target"; then'), true);
});
