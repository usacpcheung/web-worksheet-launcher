import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const fileImportHandlerIndex = mainSource.indexOf("fileInput.addEventListener('change'");
const prepareIndex = mainSource.indexOf('preparedImport = await prepareProjectImport(file)', fileImportHandlerIndex);
const confirmIndex = mainSource.indexOf('const shouldImport = await confirmProjectImport()', fileImportHandlerIndex);
const applyIndex = mainSource.indexOf('applyPreparedProjectImport(store, preparedImport)', fileImportHandlerIndex);

assert.ok(fileImportHandlerIndex > -1, 'main file import handler should exist');
assert.ok(prepareIndex > -1, 'main import flow should prepare the project before mutation');
assert.ok(confirmIndex > prepareIndex, 'main import flow should confirm after preparation');
assert.ok(applyIndex > confirmIndex, 'main import flow should apply only after confirmation');
assert.ok(
  mainSource.includes('revokeProjectObjectUrls(preparedImport.project)'),
  'cancelled prepared imports should revoke candidate object URLs',
);
assert.ok(
  indexSource.includes('id="import-confirm-overlay"') && indexSource.includes('role="dialog"'),
  'import confirmation dialog should be present in the static markup',
);

console.log('import safety source tests passed');
