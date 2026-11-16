import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { clickViewerAction } from './viewer-navigation-test-helpers.mjs';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: null, items: [] } } }));
    await page.goto(`${base}/server/viewer/`);
    await page.evaluate(async locale => {
      localStorage.setItem('worksheetLauncher.locale', locale);
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      const { createNumberAnswerControl } = await import('/server/viewer/number-answer-control.js');
      const { createBooleanAnswerControl, applyBooleanGroupState } = await import('/server/viewer/boolean-answer-control.js');
      const { t } = await import('/server/app/i18n/index.js');
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const abort = new AbortController();
      let edits = 0, toggles = 0, value = 'false';
      const input = createNumberAnswerControl({ responseConfig: { min: 0, max: 5 }, signal: abort.signal, onInput: () => { edits++; } });
      const group = createBooleanAnswerControl({ labelId: 'fixture-label', t, signal: abort.signal,
        getValue: () => value, onChange: next => { value = next; toggles++; } });
      check(input.type === 'text' && input.inputMode === 'decimal' && input.pattern && input.title, 'number keeps text input and hints');
      check(!input.hasAttribute('min') && !input.hasAttribute('max'), 'range is validated without native number coercion');
      check(group.getAttribute('role') === 'group' && group.getAttribute('aria-labelledby') === 'fixture-label', 'boolean group retains accessible prompt');
      input.value = '2'; input.dispatchEvent(new Event('input'));
      group.lastElementChild.click();
      check(edits === 1 && toggles === 1 && value === null, 'events work and legacy false toggles to unanswered');
      value = true; group.firstElementChild.click();
      check(value === null, 'boolean click reads current value rather than captured state');
      applyBooleanGroupState(group, false, true); group.lastElementChild.click();
      check(toggles === 2 && group.lastElementChild.getAttribute('aria-pressed') === 'true', 'disabled selected button does not change answer');
      applyBooleanGroupState(group, null, false);
      abort.abort();
      input.dispatchEvent(new Event('input')); group.firstElementChild.click();
      check(edits === 1 && toggles === 2, 'disposed controls cannot publish answer edits');

      const configs = [
        ['number', { inputType: 'number' }],
        ['bounded', { inputType: 'number', min: 0, max: 5, numberRules: { allowedKinds: ['integer', 'decimal'], allowSigned: false, decimalPlacesAllowed: 1 } }],
        ['decimal', { inputType: 'number', numberRules: { allowedKinds: ['decimal'], decimalPlacesAllowed: 2 } }],
        ['integer', { inputType: 'number', numberRules: { allowedKinds: ['integer'] } }],
        ['boolean', { inputType: 'boolean' }],
        ['text', { inputType: 'text', maxLength: 200 }],
      ];
      const now = new Date().toISOString();
      await viewerStorage.attempts.put({ localId: 'controls-fixture', localAttemptId: 'controls-fixture', status: 'in_progress', startedAt: now,
        viewerPayload: { worksheetId: 'controls', snapshotId: 'controls', snapshotVersion: 1, title: 'Number and boolean controls',
          blocks: configs.map(([blockId, responseConfig], position) => ({ blockId, responseConfig, position, kind: 'question', prompt: { text: `Answer ${blockId} 作答` } })) },
        answers: { boolean: { value: 'false', answeredAt: now }, text: { value: 'Keep this text', answeredAt: now } },
        metadata: { localId: 'controls-fixture', origin: 'local_source', updatedAt: now } });
    }, locale);
    await page.goto(`${base}/server/viewer/?localAttemptId=controls-fixture`);
    const number = page.locator('#answer-number');
    const boolean = page.locator('#answer-boolean');
    const selectedFalse = boolean.locator('[data-boolean-value="false"]');
    const selectedTrue = boolean.locator('[data-boolean-value="true"]');
    await number.waitFor();
    assert.deepEqual(await boolean.locator('button').allTextContents(), locale === 'en' ? ['True', 'False'] : ['是', '否']);
    assert.equal(await selectedFalse.getAttribute('aria-pressed'), 'true');
    assert.equal(await boolean.getAttribute('aria-labelledby'), 'answer-boolean-label');
    assert.match(await number.getAttribute('aria-describedby'), /answer-number-helper.*answer-number-error/);
    await page.locator('#answer-number-label').click();
    assert.equal(await number.evaluate(node => document.activeElement === node), true);
    for (const raw of ['-', '1.']) {
      await number.fill(raw);
      await number.evaluate(node => {
        window.numberBeforeRefresh = node;
        node.setSelectionRange(0, 1);
        window.viewerSession.notifyStateChange();
      });
      assert.equal(await number.inputValue(), raw);
      assert.equal(await number.evaluate(node => node === window.numberBeforeRefresh && document.activeElement === node && node.selectionStart === 0 && node.selectionEnd === 1), true);
      assert.equal(await page.evaluate(() => window.viewerSession.state.answers.number.value), '');
      assert.match(await page.locator('#answer-number-error').textContent(), /valid integer or decimal/);
    }
    await number.fill('1.20');
    assert.equal(await number.inputValue(), '1.20', 'focused numeric spelling is retained');
    assert.equal(await page.evaluate(() => window.viewerSession.state.answers.number.value), 1.2);
    await selectedFalse.click();
    assert.equal(await page.evaluate(() => window.viewerSession.state.answers.boolean.value), null);
    assert.equal(await number.inputValue(), '1.2', 'normalization after leaving focus matches the existing redraw policy');
    await selectedTrue.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.viewerSession.state.answers.boolean.value), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.viewerSession.state.answers.boolean.value), null);
    await selectedFalse.focus(); await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.viewerSession.state.answers.boolean.value), false);

    const bounded = page.locator('#answer-bounded');
    for (const [raw, message] of [['2/3', /Fractions/], ['-1', /below minimum/], ['6', /above maximum/], ['+2', /Signed values/], ['1.23', /decimal places/]]) {
      await bounded.fill(raw);
      assert.match(await page.locator('#answer-bounded-error').textContent(), message);
      assert.equal(await page.evaluate(() => window.viewerSession.state.answers.bounded.value), '');
    }
    await bounded.fill('2.5');
    assert.equal(await page.locator('#answer-bounded-error').textContent(), '');
    assert.equal(await page.evaluate(() => window.viewerSession.state.answers.bounded.value), 2.5);
    await page.locator('#answer-decimal').fill('2');
    assert.match(await page.locator('#answer-decimal-error').textContent(), /configured number format/);
    await page.locator('#answer-decimal').fill('2.34');
    await page.locator('#answer-integer').fill('2.5');
    assert.match(await page.locator('#answer-integer-error').textContent(), /configured number format/);
    await page.locator('#answer-integer').fill('2');
    await number.fill('0');
    const before = await page.evaluate(() => structuredClone(window.viewerSession.state.answers));
    await clickViewerAction(page, locale === 'en' ? 'Submit' : '提交');
    await page.waitForFunction(() => window.viewerSession.state.status === 'completed' && !window.viewerSession.state.isFinalizing);
    const verifySubmitted = async () => {
      assert.equal(await number.isDisabled(), true);
      assert.equal(await selectedTrue.isDisabled(), true);
      assert.equal(await selectedFalse.isDisabled(), true);
      assert.equal(await selectedFalse.getAttribute('aria-pressed'), 'true');
      assert.equal(await number.inputValue(), '0');
      assert.deepEqual(await page.evaluate(() => window.viewerSession.state.answers), before);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    };
    await verifySubmitted();
    if (shots) await page.screenshot({ path: `${shots}/controls-${locale}-${width}.png`, animations: 'disabled' });
    await page.evaluate(() => window.viewerSession.saveNow());
    await page.reload(); await number.waitFor();
    await verifySubmitted();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Number/boolean controls: partial typing, caret, validation, recovery, toggles, keyboard, disposal, submission and resume passed in both locales and widths');
} finally { await browser.close(); }
