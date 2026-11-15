// Local fixtures only: verify DOM stability, not just the final selected color.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({
        json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } },
      }));
      await page.goto(base + '/server/editor/');
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(async locale => {
        const { setLocale } = await import('/server/app/i18n/index.js');
        setLocale(locale);
        const s = window.editorSession;
        s.state.draft.blocks = [1, 2, 3].map((n, position) => ({
          blockId: `q${n}`, position, kind: 'question', prompt: { text: `Question ${n}` },
          responseConfig: { inputType: 'text', maxLength: 200 },
        }));
        s.selectBlock('q3');
        s.touchDraft();
        s.notifyStateChange();
      }, locale);
      const row = id => page.locator(`.block-item[data-block-id="${id}"]`);
      await row('q3').waitFor();
      await page.evaluate(() => {
        window.sidebarRows = [...document.querySelector('.block-list').children];
        window.sidebarRebuilds = 0;
        window.sidebarObserver = new MutationObserver(records => { window.sidebarRebuilds += records.length; });
        window.sidebarObserver.observe(document.querySelector('.block-list'), { childList: true });
      });
      await page.locator('#editor-block-editor').fill('Changed question three');
      assert.equal(await row('q3').locator('.block-select__title').innerText(), 'Changed question three');
      // The remembered question can be any row, not specifically question three.
      for (const id of ['q1', 'q3']) {
        await row(id).locator('.block-select').click();
        assert.equal(await row(id).evaluate(el => el.classList.contains('selected')), true);
        await page.locator('#editor-feedback-nav').click();
        await page.locator('#editor-feedback-enabled').check();
        assert.equal(await page.locator('.block-list .selected').count(), 0);
        const target = page.locator('[data-feedback-target]').first();
        await target.fill('');
        await target.pressSequentially(`Learning target after ${id}`, { delay: 10 });
        await page.locator('#editor-feedback-student-prompt').fill('Reflect on your work');
        await page.locator('#editor-feedback-teacher-prompt').fill('A next step');
        await page.locator('#editor-feedback-student-limit').fill('100');
        await target.focus();
        await page.evaluate(() => { window.feedbackFocus = document.activeElement; });
        await page.evaluate(async () => {
          await window.editorSession.saveNow();
          window.editorSession.notifyStateChange();
        });
        assert.equal(await target.evaluate(el => el === window.feedbackFocus && el === document.activeElement), true);
        assert.equal(await target.inputValue(), `Learning target after ${id}`);
        assert.equal(await page.locator('.block-list .selected').count(), 0);
      }
      await page.locator('#editor-title-input').fill('Sidebar stability');
      await page.locator('#editor-subject-input').fill('Testing');
      assert.deepEqual(await page.evaluate(() => {
        const rows = [...document.querySelector('.block-list').children];
        window.sidebarObserver.disconnect();
        return { stable: rows.every((row, i) => row === window.sidebarRows[i]), rebuilds: window.sidebarRebuilds };
      }), { stable: true, rebuilds: 0 });
      // Structural changes still refresh the rows and bind commands to the right IDs.
      await page.evaluate(() => window.editorSession.reorderBlockToIndex('q3', 0));
      assert.equal(await page.locator('.block-item').first().getAttribute('data-block-id'), 'q3');
      assert.equal(await row('q3').locator('.block-select__index').innerText(), '1.');
      await row('q3').locator('.block-select').click();
      assert.equal(await page.locator('#editor-block-editor').innerText(), 'Changed question three');
      await page.locator('#editor-block-kind').selectOption('content');
      assert.equal(await row('q3').locator('.block-kind-badge--content').count(), 1);
      const added = await page.evaluate(() => {
        const s = window.editorSession;
        const block = s.createBlock('question');
        s.notifyStateChange();
        return block.blockId;
      });
      assert.equal(await page.locator('.block-item').count(), 4);
      await page.evaluate(id => {
        const s = window.editorSession;
        s.deleteBlockWithPolicy(id, { confirmDelete: true });
        s.notifyStateChange();
      }, added);
      assert.equal(await page.locator('.block-item').count(), 3);
      const draftId = await page.evaluate(async () => {
        await window.editorSession.saveNow();
        return window.editorSession.state.draft.localId;
      });
      await page.goto(`${base}/server/editor/?localDraftId=${encodeURIComponent(draftId)}`);
      await row('q3').waitFor();
      assert.equal(await row('q3').locator('.block-kind-badge--content').count(), 1);
      await page.locator('#editor-feedback-nav').click();
      assert.equal(await page.locator('[data-feedback-target]').first().inputValue(), 'Learning target after q3');
      assert.deepEqual(errors, []);
      console.log(`PASS sidebar stability ${locale} ${width}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
