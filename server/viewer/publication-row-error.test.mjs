import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { t } from '../app/i18n/index.js';
import { getApiErrorMessage } from '../app/api/error-presentation.js';

// Exercise the production listener without introducing a runtime test hook.
const source = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const start = source.indexOf("      openBtn.addEventListener('click', async () =>");
const end = source.indexOf('      rowActions.append(openBtn)', start);
assert.ok(start >= 0 && end > start);

for (const wrapped of [false, true]) test(`publication row preserves ${wrapped ? 'wrapped' : 'direct'} thrown permission errors`, async () => {
  let handler;
  const error = { code: 'FORBIDDEN', status: 403 };
  const context = {
    session: { packageLoad: {}, startFromPublishedPackage: async () => { throw wrapped ? { error } : error; } },
    item: { published_package_id: 'fixture' }, closing: false, overlay: { isConnected: true },
    openBtn: { isConnected: true, addEventListener: (_, callback) => { handler = callback; } },
    loadError: { hidden: true }, signInBtn: { hidden: true }, updateLoadButtons() {}, t, getApiErrorMessage,
  };
  vm.runInNewContext(source.slice(start, end), context);
  await handler();
  assert.equal(context.loadError.textContent, t('apiErrors.forbidden'));
  assert.equal(context.loadError.hidden, false);
  assert.equal(context.signInBtn.hidden, true);
});

test('publication row uses a safe localized fallback for an unknown thrown error', async () => {
  let handler;
  const context = {
    session: { packageLoad: {}, startFromPublishedPackage: async () => { throw new Error('Private diagnostic'); } },
    item: {}, closing: false, overlay: { isConnected: true },
    openBtn: { isConnected: true, addEventListener: (_, callback) => { handler = callback; } },
    loadError: {}, signInBtn: { hidden: true }, updateLoadButtons() {}, t, getApiErrorMessage,
  };
  vm.runInNewContext(source.slice(start, end), context);
  await handler();
  assert.equal(context.loadError.textContent, t('apiErrors.openFailed'));
  assert.equal(context.loadError.textContent.includes('Private diagnostic'), false);
});
