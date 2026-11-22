import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  const page = await browser.newPage({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
  const errors = [];
  const requests = [];
  const root = 'https://lesson.test';
  const entry = '/worksheet_launcher/app/writing-assist.js';
  let result = 'Revised\nanswer';
  let delay;
  let signedIn = true;
  page.on('pageerror', error => errors.push(error.message));
  await page.route(root + '/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    if (pathname === '/lesson') {
      const fields = Array.from({ length: 30 }, (_, i) =>
        `<label for="q${i}">Question ${i}</label><textarea data-writing-assist="toolbar" id="q${i}" maxlength="20"></textarea>`);
      return route.fulfill({ contentType: 'text/html', body:
        `<html lang="en"><script type="module" src="${entry}"></script><body>${fields.join('')}<fieldset id="group"><label for="short">Short</label><input id="short" maxlength="5" data-writing-assist="toolbar"></fieldset></body></html>` });
    }
    if (pathname.endsWith('/session') && !signedIn) return route.fulfill({ status: 401, body: 'Unauthorized' });
    if (pathname.endsWith('/session')) return route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' } } } });
    if (pathname.endsWith('/transcriptions')) return route.fulfill({ json: { ok: true, result: 'Voice' } });
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
  const short = page.locator('#short');
  const shortField = page.locator('.wa-field').filter({ has: short });
  // Some lesson fonts spread text dots beyond the hit target on mobile.
  await page.setViewportSize({ width: 393, height: 844 });
  await page.addStyleTag({ content: '.field-tools { font-size: 28px !important; letter-spacing: 12px; }' });
  await page.evaluate(async path => {
    (await import(path)).setLayout(document.querySelector('#short'), 'compact');
  }, entry);
  const trigger = shortField.getByRole('button', { name: 'Short · Writing tools' });
  for (const width of ['100%', '75%']) {
    await short.evaluate((el, w) => { el.style.width = w; }, width);
    await short.focus();
    await page.waitForFunction(() => {
      const input = document.querySelector('#short');
      const trigger = input.parentElement.querySelector('.field-tools');
      const icon = trigger.querySelector('svg')?.getBoundingClientRect();
      const box = trigger.getBoundingClientRect();
      const field = input.getBoundingClientRect();
      return icon?.width === 20 && icon.height === 20
        && box.right <= field.right && box.left >= field.left
        && icon.left >= box.left && icon.right <= box.right
        && Math.abs(icon.left + icon.right - box.left - box.right) <= 1
        && Math.abs(icon.top + icon.bottom - box.top - box.bottom) <= 1;
    });
  }
  await trigger.locator('svg').click();
  await shortField.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  await page.evaluate(async path => {
    (await import(path)).setLayout(document.querySelector('#short'), 'toolbar');
  }, entry);
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill('🌱\noriginal');
  assert.equal(await field.locator('.field-count').textContent(), '11/20');
  assert.equal(await page.locator('.wa-field').count(), 31);
  assert.ok(!requests.some(path => path.startsWith('/api/') || path.endsWith('/workflow.js')));
  await button('rewrite').click();
  await page.waitForFunction(() => document.querySelector('#q0').value === 'Revised\nanswer');
  await message.filter({ hasText: 'Rewritten' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.assist-message').textContent === '');
  await button('undo').click();
  assert.equal(await input.inputValue(), '🌱\noriginal');
  const shortAction = action => shortField.locator(`[data-action="${action}"]`);
  await short.fill('start');
  signedIn = false;
  await shortAction('voice').click();
  await page.getByRole('dialog').waitFor();
  await page.locator('#group').evaluate(group => { group.disabled = true; });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('#group').evaluate(group => { group.disabled = false; });
  await page.waitForFunction(() => !document.querySelector('#group [data-action="voice"]').disabled);
  assert.equal(await shortField.locator('.recovery').isVisible(), false);
  signedIn = true;
  result = 'ab\n\ncd';
  await shortAction('rewrite').click();
  await page.waitForFunction(() => document.querySelector('#short').value === 'ab cd', null, { timeout: 4000 });
  result = '🌱\r\n\r\n🌱x';
  await shortAction('rewrite').click();
  await shortField.locator('.recovery').waitFor({ state: 'visible' });
  assert.equal(await short.inputValue(), 'ab cd');
  await shortField.locator('.recovery textarea').fill('🌱\n\n🌱');
  await shortAction('retry').click();
  await page.waitForFunction(() => document.querySelector('#short').value === '🌱 🌱');
  assert.equal(await shortField.locator('.field-count').textContent(), '5/5');
  let unlock;
  delay = new Promise(resolve => { unlock = resolve; });
  const started = page.waitForRequest(root + '/api/rewrite-bridge/rewrite');
  await shortAction('rewrite').click();
  await started;
  await page.locator('#group').evaluate(group => { group.disabled = true; });
  unlock();
  delay = null;
  await shortAction('cancel').waitFor({ state: 'hidden' });
  assert.equal(await short.inputValue(), '🌱 🌱');
  assert.equal(await shortAction('rewrite').isDisabled(), true);
  await page.locator('#group').evaluate(group => { group.disabled = false; });
  await page.waitForFunction(() => !document.querySelector('#group [data-action="rewrite"]').disabled);
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
  assert.equal(await page.locator('.wa-field').count(), 31);
  assert.equal(requests.filter(path => path.endsWith('/writing-assist/workflow.js')).length, 1);
  await page.clock.install();
  result = 'Voice';
  delay = null;
  const timer = field.getByRole('timer');
  for (const finish of ['cancel', 'stop', 'automatic']) {
    await input.fill('');
    const before = requests.filter(path => path.endsWith('/transcriptions')).length;
    await button('voice').click();
    await timer.waitFor();
    assert.equal(await timer.textContent(), '0:00 / 1:00');
    assert.equal(await page.getByRole('timer').count(), 1);
    await page.clock.fastForward(1000);
    await page.waitForFunction(() => document.querySelector('.wa-clock:not([hidden])')?.textContent === '0:01 / 1:00');
    const clockBox = await timer.boundingBox();
    const countBox = await field.locator('.field-count').boundingBox();
    assert.ok(clockBox.x + clockBox.width <= countBox.x);
    if (finish === 'automatic') await page.clock.fastForward(58500);
    else await button(finish).click();
    await timer.waitFor({ state: 'hidden' });
    await button('cancel').waitFor({ state: 'hidden' });
    assert.equal(requests.filter(path => path.endsWith('/transcriptions')).length, before + Number(finish !== 'cancel'));
    assert.equal(await input.inputValue(), finish === 'cancel' ? '' : 'Voice');
    if (await button('discard').isVisible()) await button('discard').click();
  }
  assert.deepEqual(errors, []);
  console.log('Writing assistance smoke passed');
} finally {
  await browser.close();
}
