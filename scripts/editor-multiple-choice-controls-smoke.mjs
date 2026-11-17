import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { items: [] } } }));
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(() => {
        const s = window.editorSession;
        s.state.draft.title = 'Multiple-choice controls fixture';
        s.state.draft.blocks = ['empty', 'other'].map((id, position) => ({ blockId: id, position, kind: 'question',
          prompt: { text: `Choose an option ${id}`, format: 'plain_text' },
          responseConfig: { inputType: 'multiple_choice', selectionMode: 'single', options: id === 'empty' ? [] : [{ id: 'other-a', value: 'Other A', label: 'Other A' }, { id: 'other-b', value: 'Other B', label: 'Other B' }] } }));
        s.selectBlock('empty'); s.touchDraft(); s.notifyStateChange();
      });
      const config = id => page.evaluate(id => window.editorSession.findBlock(id).responseConfig, id);
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const select = id => page.locator(`.block-item[data-block-id="${id}"] .block-select`).click();
      const rows = page.locator('.question-options-list .option-row');
      const input = index => rows.nth(index).locator('[data-option-input]');
      const correct = index => rows.nth(index).locator('.option-correct-toggle');
      const mode = page.locator('#editor-question-selection-mode');
      const modal = page.getByRole('dialog');
      const paste = (index, text) => input(index).evaluate((el, text) => {
        const data = new DataTransfer(); data.setData('text', text);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      }, text);
      assert.equal(await rows.count(), 1);
      const initialId = await rows.first().getAttribute('data-option-id');
      assert.equal(await rows.first().getAttribute('data-persisted-option'), '0');
      await input(0).focus();
      await input(0).evaluate(el => {
        window.composingInput = el;
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = '水'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        window.editorSession.notifyStateChange();
      });
      assert.equal((await config('empty')).options.length, 0, 'composition does not commit early');
      assert.equal(await input(0).evaluate(el => el === window.composingInput && el === document.activeElement), true);
      await input(0).dispatchEvent('compositionend');
      assert.equal((await config('empty')).options[0].id, initialId);
      assert.equal((await config('empty')).options[0].label, '水');
      assert.equal(await rows.first().getAttribute('data-persisted-option'), '1');
      await input(0).fill('Water');
      await input(0).evaluate(el => { window.beforeRefresh = el; el.setSelectionRange(1, 3); });
      await page.evaluate(async () => { await window.editorSession.autosave(); window.editorSession.notifyStateChange(); });
      assert.equal(await input(0).evaluate(el => el === window.beforeRefresh && el === document.activeElement && el.selectionStart === 1 && el.selectionEnd === 3), true);
      // A structural change forces redraw; the shell still restores the active input's caret.
      await page.evaluate(() => { const s = window.editorSession; s.updateQuestionOptionAtIndex('empty', 1, 'Air'); s.notifyStateChange(); });
      assert.equal(await input(0).evaluate(el => el !== window.beforeRefresh && el === document.activeElement && el.selectionStart === 1 && el.selectionEnd === 3), true);
      await correct(0).click(); assert.equal((await config('empty')).correctAnswerOptionId, initialId);
      await correct(0).click(); assert.equal((await config('empty')).correctAnswerOptionId, undefined);
      await correct(0).click();
      await mode.selectOption('multi'); assert.deepEqual((await config('empty')).correctAnswerOptionIds, [initialId]);
      await correct(1).click(); assert.equal((await config('empty')).correctAnswerOptionIds.length, 2);
      await correct(0).click(); assert.equal((await config('empty')).correctAnswerOptionIds.length, 1);
      await mode.selectOption('single'); assert.equal((await config('empty')).correctAnswerOptionId, (await config('empty')).options[1].id);
      await page.getByRole('button', { name: await label('editor.question.toggleShuffleAria'), exact: true }).click();
      assert.equal((await config('empty')).shuffleOptions, true);
      await page.locator('.option-add-btn').click(); assert.equal(await rows.count(), 3);
      await input(2).fill('Extra');
      await rows.nth(2).getByRole('button', { name: 'Delete option 3', exact: true }).click();
      await modal.locator('button').first().click(); assert.equal((await config('empty')).options.length, 3);
      await rows.nth(2).getByRole('button', { name: 'Delete option 3', exact: true }).click();
      await modal.locator('button').last().click(); assert.equal((await config('empty')).options.length, 2);
      // Hidden bulk-input compatibility path and duplicate warning remain intact.
      await page.locator('#editor-question-options').evaluate(el => { el.value = 'Same\nSame'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.locator('.option-warning').waitFor({ state: 'visible' });
      await input(1).fill('Different'); await input(1).blur();
      await page.evaluate(() => window.editorSession.notifyStateChange());
      await page.locator('.option-warning').waitFor({ state: 'hidden' });
      await paste(0, 'First\nSecond');
      assert.deepEqual((await config('empty')).options.map(o => o.label), ['First', 'Second']);
      // Legacy audio-removal paste confirmation: cancel keeps data, confirm removes its asset.
      await page.evaluate(async () => {
        const s = window.editorSession;
        await s.storage.localAssets.put({ assetId: 'legacy-audio', binary: new Uint8Array([1, 2, 3]), metadata: { localId: 'legacy-audio', origin: 'local', updatedAt: new Date().toISOString(), mimeType: 'audio/mpeg' } });
        const block = s.findBlock('empty'); block.responseConfig.options[0].mediaRefs = [{ usage: 'option_audio', assetId: 'legacy-audio' }];
        s.touchDraft(); s.notifyStateChange();
      });
      await paste(0, 'Changed first\nChanged second'); await modal.locator('button').first().click();
      assert.equal((await config('empty')).options[0].label, 'First');
      await paste(0, 'Changed first\nChanged second'); await modal.locator('button').last().click();
      assert.equal((await config('empty')).options[0].label, 'Changed first');
      assert.deepEqual((await config('empty')).options[0].mediaRefs, []);
      // Text edits still refresh audio eligibility without rebuilding the active input.
      await input(0).fill('x'.repeat(201));
      assert.equal(await rows.first().locator('[data-option-audio-action="generate"]').first().isDisabled(), true);
      await input(0).fill('Short option');
      assert.equal(await rows.first().locator('[data-option-audio-action="generate"]').first().isEnabled(), true);
      await input(0).evaluate(el => { window.oldRowInput = el; });
      const expectedEmpty = await config('empty');
      await select('other');
      await page.evaluate(() => { window.oldRowInput.value = 'Stale'; window.oldRowInput.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.deepEqual(await config('empty'), expectedEmpty);
      assert.equal((await config('other')).options[0].label, 'Other A');
      await mode.evaluate(el => { window.oldMode = el; });
      await page.locator('.language-selector select').selectOption(locale === 'en' ? 'zh-Hant' : 'en');
      await page.evaluate(() => { window.oldMode.value = 'multi'; window.oldMode.dispatchEvent(new Event('change', { bubbles: true })); });
      assert.equal((await config('other')).selectionMode, 'single');
      const revision = await page.evaluate(() => window.editorSession.state.draftRevision);
      await input(0).fill('Fresh edit');
      assert.equal(await page.evaluate(() => window.editorSession.state.draftRevision), revision + 1);
      const expected = await page.evaluate(() => window.editorSession.state.draft.blocks.map(b => b.responseConfig));
      const id = await page.evaluate(async () => { await window.editorSession.saveNow(); return window.editorSession.state.draft.localId; });
      await page.goto(`${base}/server/editor/?localDraftId=${encodeURIComponent(id)}`);
      await page.waitForFunction(() => window.editorSession?.state.draft?.blocks.length === 2);
      assert.deepEqual(await page.evaluate(() => window.editorSession.state.draft.blocks.map(b => b.responseConfig)), expected);
      await select('empty');
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) {
        await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
        await rows.first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.VIEWER_SMOKE_SCREENSHOTS, `controls-${locale}-${width}.png`) });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: await label('editor.actions.exportPackage'), exact: true }).click()]);
      await page.locator('input[type="file"][accept="application/zip,.zip"]').setInputFiles({ name: 'mc-roundtrip.zip', mimeType: 'application/zip', buffer: await readFile(await download.path()) });
      await modal.getByRole('button', { name: await label('editor.replaceWorksheet.confirm'), exact: true }).click();
      await page.waitForFunction(id => window.editorSession.state.draft.localId !== id && !window.editorSession.packageLoad.current, id);
      const imported = await page.evaluate(() => window.editorSession.state.draft.blocks.map(b => b.responseConfig));
      for (let i = 0; i < imported.length; i++) {
        assert.deepEqual(imported[i].options.map(o => o.label), expected[i].options.map(o => o.label));
        assert.equal(imported[i].selectionMode, expected[i].selectionMode);
        assert.equal(imported[i].shuffleOptions, expected[i].shuffleOptions);
        assert.deepEqual(imported[i].correctAnswer, expected[i].correctAnswer);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS multiple-choice controls ${locale}/${width}: IME, caret, identity, modes, paste, lifecycle, media eligibility and ZIP`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
