import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  const root = 'https://lesson.test';
  const entry = '/worksheet_launcher/app/writing-assist.js';
  let result = 'Revised\nanswer';
  let delay;
  page.on('pageerror', error => errors.push(error.message));
  await page.route(root + '/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    if (pathname === '/lesson') {
      const fields = Array.from({ length: 30 }, (_, i) =>
        `<label for="q${i}">Question ${i}</label><textarea data-writing-assist="toolbar" id="q${i}" maxlength="20"></textarea>`);
      return route.fulfill({ contentType: 'text/html', body:
        `<html lang="en"><script type="module" src="${entry}"></script><body>${fields.join('')}</body></html>` });
    }
    if (pathname.endsWith('/session')) return route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' } } } });
    if (pathname.endsWith('/rewrite')) {
      if (delay) await delay;
      return route.fulfill({ json: { ok: true, result } });
    }
    assert.ok(pathname.startsWith('/worksheet_launcher/'));
    const file = new URL('../server/' + pathname.slice('/worksheet_launcher/'.length), import.meta.url);
    await route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(file) });
  });
  await page.goto(root + '/lesson');
  const field = page.locator('.wa-field').first();
  const input = page.locator('#q0');
  const button = action => field.locator(`[data-action="${action}"]`);
  const message = field.locator('.assist-message');
  await input.fill('🌱\noriginal');
  assert.equal(await field.locator('.field-count').textContent(), '11/20');
  assert.equal(await page.locator('.wa-field').count(), 30);
  assert.ok(!requests.some(path => path.startsWith('/api/') || path.endsWith('/workflow.js')));
  await button('rewrite').click();
  await page.waitForFunction(() => document.querySelector('#q0').value === 'Revised\nanswer');
  await message.filter({ hasText: 'Rewritten' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.assist-message').textContent === '');
  await button('undo').click();
  assert.equal(await input.inputValue(), '🌱\noriginal');
  result = 'x'.repeat(21);
  await button('rewrite').click();
  await field.locator('.recovery').waitFor({ state: 'visible' });
  assert.equal(await input.inputValue(), '🌱\noriginal');
  await button('discard').click();
  let release;
  delay = new Promise(resolve => { release = resolve; });
  const sent = page.waitForRequest(root + '/api/rewrite-bridge/rewrite');
  await button('rewrite').click();
  await sent;
  await page.evaluate(async path => {
    const { attach } = await import(path);
    const input = document.querySelector('#q0');
    const next = input.cloneNode(false);
    next.value = 'replacement';
    input.replaceWith(next);
    attach(next);
    attach(next);
  }, entry);
  release();
  assert.equal(await input.inputValue(), 'replacement');
  assert.equal(await page.locator('.wa-field').count(), 30);
  assert.equal(requests.filter(path => path.endsWith('/writing-assist/workflow.js')).length, 1);
  assert.deepEqual(errors, []);
  console.log('Writing assistance smoke passed');
} finally {
  await browser.close();
}
