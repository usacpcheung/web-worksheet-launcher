import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route(url => url.pathname.startsWith('/api/'), r => r.fulfill({ json: { ok: true, data: { items: [] } } }));
    await page.goto(base + '/server/editor/'); await page.waitForFunction(() => window.editorSession);
    await page.evaluate(async locale => { (await import('/server/app/i18n/index.js')).setLocale(locale); }, locale);
    await page.reload(); await page.waitForFunction(() => window.editorSession);
    await page.evaluate(() => {
      const s = window.editorSession;
      s.state.draft.title = 'Layout acceptance fixture';
      s.state.draft.blocks = [{ blockId: 'layout-q', kind: 'question', position: 0, prompt: { text: '' }, responseConfig: { inputType: 'text', maxLength: 200 } }];
      s.state.selectedBlockId = 'layout-q'; s.notifyStateChange();
    });
    const type = page.locator('#editor-question-input-type');
    const prompt = page.locator('#editor-block-editor');
    const media = page.locator('.editor-prompt-media');
    const modal = page.locator('.confirm-modal');
    const accept = () => modal.locator('.confirm-modal__actions button').last().click();
    const cancel = () => modal.locator('.confirm-modal__actions button').first().click();
    assert.equal(await type.inputValue(), 'text');
    assert.ok((await type.boundingBox()).y < (await prompt.boundingBox()).y);
    assert.equal(await media.evaluate(e => e.open), true);
    await prompt.fill('Plants need water.');
    await type.selectOption('fill_in_blanks'); await cancel(); assert.equal(await type.inputValue(), 'text');
    assert.equal(await prompt.textContent(), 'Plants need water.');
    await type.selectOption('fill_in_blanks'); await accept();
    const passage = page.locator('.editor-blank-passage .tiptap');
    await passage.waitFor(); assert.equal(await passage.textContent(), 'Plants need water.');
    assert.equal(await page.locator('.editor-instructions').evaluate(e => e.open), false);
    assert.ok((await passage.boundingBox()).y < (await media.boundingBox()).y);
    assert.equal(await page.locator('.answer-section').count(), 0);
    assert.equal(await page.locator('[data-prompt-audio-track-language=cantonese] [data-audio-track-action=generate]').isDisabled(), true);
    await passage.evaluate(el => {
      el.focus(); const node = el.querySelector('p').firstChild, range = document.createRange();
      range.setStart(node, 12); range.setEnd(node, 17); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('#editor-make-blank').click();
    await page.locator('#editor-blank-answer').fill('rain');
    assert.equal(await page.evaluate(() => window.editorSession.validateCurrentDraft().valid), true);
    await page.evaluate(async () => {
      const s = window.editorSession;
      const { createWorksheetPackageFromDraft, parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
      const packaged = createWorksheetPackageFromDraft(s.state.draft, []);
      const parsed = parseWorksheetPackage(packaged.bytes);
      if (parsed.worksheet.blocks[0].prompt.text !== '') throw new Error('Empty instructions changed on export');
      if (!s.deleteBlockWithPolicy('layout-q').reason) throw new Error('Passage deleted without confirmation');
      await s.saveNow();
    });
    if (shots) await page.screenshot({ path: `${shots}/blanks-${locale}-${width}.png`, fullPage: true });
    await type.selectOption('text'); await modal.waitFor();
    assert.match(await modal.locator('.editor-type-preview-text').textContent(), /Plants need rain/);
    await cancel(); assert.equal(await passage.locator('.editor-blank-mark').count(), 1);
    await type.selectOption('text'); await accept(); assert.match(await prompt.textContent(), /Plants need rain/);
    await type.selectOption('fill_in_blanks');
    await modal.locator('[value=instructions]').check(); await accept();
    assert.equal(await passage.textContent(), '');
    assert.equal(await page.locator('.editor-instructions').evaluate(e => e.open), true);
    assert.match(await prompt.textContent(), /Plants need rain/);
    // Stale dialogs must never apply a conversion to a newer question revision.
    await type.selectOption('text'); await modal.waitFor();
    await page.evaluate(() => { window.editorSession.findBlock('layout-q').prompt = { text: 'Concurrent edit' }; });
    await accept(); assert.equal(await type.inputValue(), 'fill_in_blanks');
    assert.equal(await prompt.textContent(), 'Concurrent edit');
    await passage.fill('字'.repeat(600));
    await type.selectOption('text'); await modal.waitFor();
    assert.equal(await modal.locator('.editor-type-preview .input-error').count(), 1);
    await cancel(); assert.equal((await passage.textContent()).length, 600);
    const kind = page.locator('#editor-block-kind');
    await kind.selectOption('content'); await cancel(); assert.equal(await kind.inputValue(), 'question');
    await kind.selectOption('content'); await accept(); assert.equal(await kind.inputValue(), 'content');
    assert.equal((await prompt.textContent()).includes('字'.repeat(600)), true);
    await kind.selectOption('question');
    // Audio selectors show independent attachment and selection states.
    await page.evaluate(async () => {
      const s = window.editorSession, block = s.findBlock('layout-q');
      block.prompt = { text: 'Audio source' }; block.responseConfig = { inputType: 'text', maxLength: 200 };
      for (const language of ['cantonese', 'english']) {
        const result = await s.attachAudioTrack('layout-q', 'prompt', language, new File(['fixture'], language + '.mp3', { type: 'audio/mpeg' }));
        if (!result.ok) throw new Error(JSON.stringify(result));
      }
      window.playCount = 0; window.generateCount = 0;
      s.playAssetAudio = async () => { window.playCount++; return { ok: true }; };
      s.triggerProtectedAction = async () => { window.generateCount++; return { ok: true }; };
      s.notifyStateChange();
    });
    const language = key => page.locator(`[data-prompt-audio-language=${key}]`);
    assert.equal(await page.locator('.editor-audio-language--attached').count(), 2);
    await language('mandarin').click();
    assert.equal(await language('mandarin').getAttribute('aria-pressed'), 'true');
    assert.equal(await language('mandarin').isEnabled(), true);
    assert.equal(await page.locator('[data-prompt-audio-track-language=mandarin] [data-audio-track-action=play]').isDisabled(), true);
    assert.equal(await page.locator('[data-prompt-audio-track-language]:visible').count(), 1);
    assert.deepEqual(await page.evaluate(() => [window.playCount, window.generateCount]), [0, 0]);
    if (shots) await media.screenshot({ path: `${shots}/audio-${locale}-${width}.png` });
    await language('english').focus(); await page.keyboard.press('Enter');
    await page.locator('[data-prompt-audio-track-language=english] .audio-track-more-menu__toggle').click();
    const menuBounds = await page.locator('[data-prompt-audio-track-language=english] .audio-track-more-menu__list').boundingBox();
    assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width + 1, 'audio overflow menu stays in viewport');
    await page.locator('[data-prompt-audio-track-language=english] [data-audio-track-action=remove]').click();
    await accept();
    assert.equal(await language('english').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.editor-audio-language--attached').count(), 1);
    assert.equal(await language('english').evaluate(e => e === document.activeElement), true, 'removal returns focus to the selected language');
    await media.locator(':scope > summary').click(); assert.equal(await media.evaluate(e => e.open), false);
    await page.evaluate(() => { const s = window.editorSession; s.touchDraft(); s.notifyStateChange(); });
    assert.equal(await media.evaluate(e => e.open), false);
    await page.evaluate(() => { const s = window.editorSession; s.createBlock('question'); s.notifyStateChange(); });
    assert.equal(await type.inputValue(), 'text'); assert.equal(await media.evaluate(e => e.open), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS editor layout ${locale}/${width}: conversion, cancel, stale edits, limits, audio selection/removal and new-question defaults`);
  }
} finally { await browser.close(); }
