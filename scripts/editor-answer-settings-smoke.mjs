// Disposable local drafts only; tests actual controls and ZIP export/import.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({
        json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } },
      }));
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession?.state.serverSession.status === 'ready');
      await page.evaluate(() => {
        const s = window.editorSession;
        s.state.draft.blocks = [
          ['text', { inputType: 'text', maxLength: 200, textMode: 'standard', displayMode: 'multi_line' }],
          ['other', { inputType: 'text', maxLength: 80, textMode: 'standard', displayMode: 'single_line' }],
          ['number', { inputType: 'number', min: -2, max: 10, numberRules: { allowSigned: true, decimalPlacesAllowed: 2 }, correctAnswer: 0 }],
          ['boolean', { inputType: 'boolean' }],
        ].map(([blockId, responseConfig], position) => ({ blockId, responseConfig, position, kind: 'question', prompt: { text: `Fixture ${blockId}`, format: 'plain_text' } }));
        s.selectBlock('text'); s.touchDraft(); s.notifyStateChange();
      });
      const select = id => page.locator(`.block-item[data-block-id="${id}"] .block-select`).click();
      const config = id => page.evaluate(id => window.editorSession.findBlock(id).responseConfig, id);
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const limit = page.locator('#editor-question-max-length');
      await limit.fill('1201');
      assert.equal(await limit.getAttribute('aria-invalid'), 'true');
      assert.notEqual(await page.locator('[data-text-limit-error]').textContent(), '');
      await limit.fill('1200');
      await limit.fill('');
      await page.evaluate(() => window.editorSession.notifyStateChange());
      assert.equal(await limit.inputValue(), '', 'focused empty input is preserved');
      assert.equal((await config('text')).maxLength, 1200, 'existing policy keeps last valid value');
      await page.locator('[data-text-display-mode="single_line"]').click();
      assert.equal(await limit.inputValue(), '1200');
      await select('other');
      assert.equal(await limit.inputValue(), '80');
      await select('text');
      assert.equal(await limit.inputValue(), '1200');
      // A confirmation cannot update a question after selection changes.
      await page.locator('#editor-question-long-text').check();
      await page.locator('#editor-question-long-text').click();
      await page.getByRole('dialog').waitFor();
      await page.evaluate(() => { const s = window.editorSession; s.selectBlock('other'); s.notifyStateChange(); });
      await page.getByRole('dialog').getByRole('button', { name: await label('textAnswer.switchConfirm'), exact: true }).click();
      assert.equal((await config('text')).textMode, 'long');
      assert.equal((await config('other')).maxLength, 80);
      await select('number');
      const answer = page.locator('#editor-question-correct-answer-number');
      const decimals = page.locator('#editor-question-number-decimal-places-allowed');
      assert.equal(await answer.inputValue(), '0');
      await answer.fill('');
      assert.equal(Object.hasOwn(await config('number'), 'correctAnswer'), false);
      await answer.fill('-1.5');
      await decimals.fill('1.5');
      await decimals.evaluate(el => { window.focusedDecimal = el; });
      await page.evaluate(async () => { await window.editorSession.autosave(); window.editorSession.notifyStateChange(); });
      assert.equal(await decimals.inputValue(), '1.5');
      assert.equal(await decimals.evaluate(el => el === window.focusedDecimal && el === document.activeElement), true);
      assert.equal(await decimals.evaluate(el => el.classList.contains('control-invalid')), true);
      await decimals.fill('');
      assert.equal((await config('number')).numberRules.decimalPlacesAllowed, null);
      await decimals.fill('2');
      await page.locator('#editor-question-min').fill('20');
      assert.equal(await page.locator('#editor-question-min').evaluate(el => el.classList.contains('control-invalid')), true);
      await page.locator('#editor-question-min').fill('0');
      await answer.fill('0');
      await page.getByRole('button', { name: await label('editor.question.toggleSignedValuesAria'), exact: true }).click();
      assert.equal((await config('number')).numberRules.allowSigned, false);
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) {
        await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
        await page.locator('.number-answer-range').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.VIEWER_SMOKE_SCREENSHOTS, `number-${locale}-${width}.png`), fullPage: true });
      }
      await select('boolean');
      const no = page.locator('[data-boolean-answer-value="false"]');
      const yes = page.locator('[data-boolean-answer-value="true"]');
      await no.click();
      assert.equal((await config('boolean')).correctAnswer, false);
      assert.equal(await no.getAttribute('aria-pressed'), 'true');
      await no.click();
      assert.equal(Object.hasOwn(await config('boolean'), 'correctAnswer'), false);
      await yes.click();
      assert.equal((await config('boolean')).correctAnswer, true);
      // Detached controls lose their handlers; current controls apply one mutation.
      await select('number');
      await answer.evaluate(el => { window.oldNumberControl = el; });
      await page.locator('.language-selector select').selectOption(locale === 'en' ? 'zh-Hant' : 'en');
      await page.evaluate(() => { window.oldNumberControl.value = '8'; window.oldNumberControl.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.equal((await config('number')).correctAnswer, 0);
      const revision = await page.evaluate(() => window.editorSession.state.draftRevision);
      await answer.fill('1');
      assert.equal(await page.evaluate(() => window.editorSession.state.draftRevision), revision + 1);
      const expected = await page.evaluate(() => window.editorSession.state.draft.blocks.map(b => b.responseConfig));
      const localId = await page.evaluate(async () => { await window.editorSession.saveNow(); return window.editorSession.state.draft.localId; });
      await page.goto(`${base}/server/editor/?localDraftId=${encodeURIComponent(localId)}`);
      await page.waitForFunction(() => window.editorSession?.state.draft?.blocks.length === 4);
      assert.deepEqual(await page.evaluate(() => window.editorSession.state.draft.blocks.map(b => b.responseConfig)), expected);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: await label('editor.actions.exportPackage'), exact: true }).click(),
      ]);
      await page.locator('input[type="file"][accept="application/zip,.zip"]').setInputFiles({ name: 'answer-settings-fixture.zip', mimeType: 'application/zip', buffer: await readFile(await download.path()) });
      await page.getByRole('dialog').getByRole('button', { name: await label('editor.replaceWorksheet.confirm'), exact: true }).click();
      await page.waitForFunction(id => window.editorSession.state.draft.localId !== id && !window.editorSession.packageLoad.current, localId);
      const imported = await page.evaluate(() => window.editorSession.state.draft.blocks.map(b => b.responseConfig));
      assert.equal(imported[0].textMode, 'long');
      assert.equal(imported[0].maxLength, 20000);
      assert.equal(imported[1].maxLength, 80);
      assert.equal(imported[2].correctAnswer, 1);
      assert.deepEqual(imported[2], expected[2], 'numeric rules and answer survive package normalization');
      assert.equal(imported[3].correctAnswer, true);
      // Excluded types continue to render without the extracted controls leaking in.
      for (const type of ['multiple_choice', 'image_response', 'fill_in_blanks']) {
        await page.evaluate(() => { const s = window.editorSession; s.createBlock('question'); s.notifyStateChange(); });
        await page.locator('#editor-question-input-type').selectOption(type);
        assert.equal(await page.locator('#editor-question-input-type').inputValue(), type);
        assert.equal(await page.locator('#editor-question-max-length, #editor-question-correct-answer-number, #editor-question-correct-answer-boolean').count(), 0);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS answer settings ${locale} ${width}: raw input, modes, validation, zero/false, lifecycle and ZIP roundtrip`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
