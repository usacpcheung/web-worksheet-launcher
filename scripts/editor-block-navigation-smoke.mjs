// Isolated fixtures: shell disposal, stale gestures, delete callbacks and preview return.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({
        json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } },
      }));
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession?.state.serverSession.status === 'ready');
      await page.evaluate(() => {
        const s = window.editorSession;
        s.state.draft.blocks = Array.from({ length: 18 }, (_, i) => ({
          blockId: `nav-${i}`, position: i, kind: i < 4 ? 'content' : 'question',
          ...(i < 4 ? { content: { text: `Reading ${i}`, format: 'plain_text' } }
            : { prompt: { text: `Question ${i}`, format: 'plain_text' }, responseConfig: { inputType: 'text', maxLength: 200 } }),
        }));
        s.selectBlock('nav-0'); s.touchDraft(); s.notifyStateChange();
      });
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const row = id => page.locator(`.block-item[data-block-id="nav-${id}"]`);
      const order = () => page.evaluate(() => window.editorSession.state.draft.blocks.map(b => b.blockId));
      const original = await order();
      assert.equal(await row(0).locator('.block-kind-badge').textContent(), await label('editor.block.kind.content'));
      assert.equal(await row(4).locator('.block-kind-badge').textContent(), await label('editor.block.kind.question'));
      // Programmatic language-change events exercise shell replacement while modal UI is active.
      const replaceShell = () => page.evaluate(() => {
        const select = document.querySelector('.language-selector select');
        select.value = select.value === 'en' ? 'zh-Hant' : 'en';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await row(0).locator('.block-reorder-trigger').click();
      await page.evaluate(() => {
        window.discardedMenu = document.querySelector('.block-reorder-menu');
        window.discardedList = document.querySelector('.block-list');
      });
      await replaceShell();
      assert.equal(await page.locator('.block-reorder-menu').count(), 0);
      await page.evaluate(() => {
        // Detached controls must not mutate the active session after disposal.
        window.discardedMenu.querySelector('button:not(:disabled)').click();
        window.discardedList.querySelector('.block-select').click();
        window.discardedList.querySelector('.danger').click();
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('scroll'));
      });
      assert.deepEqual(await order(), original);
      assert.equal(await page.locator('dialog[open]').count(), 0);
      await row(0).locator('.block-reorder-trigger').click();
      await page.locator('.block-reorder-menu').getByRole('menuitem', { name: await label('editor.reorder.position'), exact: true }).click();
      await page.locator('.editor-block-position-dialog select').selectOption('5');
      await page.evaluate(() => { window.discardedPositionForm = document.querySelector('.editor-block-position-dialog form'); });
      await replaceShell();
      assert.equal(await page.locator('.editor-block-position-dialog').count(), 0);
      await page.evaluate(() => window.discardedPositionForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      assert.deepEqual(await order(), original);
      // Cancel an active drag on replacement, including its edge-scroll animation.
      await row(0).locator('.block-drag-handle').scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        const list = document.querySelector('.block-list');
        const handle = list.querySelector('.block-drag-handle');
        const transfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
        const rect = list.getBoundingClientRect();
        list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer,
          clientX: rect.left + 20, clientY: Math.min(rect.bottom, innerHeight) - 4 }));
        window.discardedDragList = list;
      });
      assert.equal(await page.locator('.block-item--dragging').count(), 1);
      await replaceShell();
      const cancelled = await page.evaluate(() => {
        const old = window.discardedDragList;
        old.querySelector('.block-drag-handle').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
        return old.querySelectorAll('.block-item--dragging, .block-item--drop-before, .block-item--drop-after').length;
      });
      assert.equal(cancelled, 0);
      assert.deepEqual(await order(), original);
      // A different worksheet with the same block IDs cannot use an old destination.
      await row(0).locator('.block-reorder-trigger').click();
      await page.locator('.block-reorder-menu').getByRole('menuitem', { name: await label('editor.reorder.position'), exact: true }).click();
      await page.evaluate(() => { const s = window.editorSession; s.state.draft.localId += '-replacement'; s.touchDraft(); s.notifyStateChange(); });
      await page.locator('.editor-block-position-dialog select').selectOption('5');
      await page.locator('.editor-block-position-dialog button[type="submit"]').click();
      assert.deepEqual(await order(), original);
      // Existing deletion policy stays in the shell and still supports Cancel/confirm.
      await row(17).locator('.danger').click();
      await page.getByRole('dialog').getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      assert.deepEqual(await order(), original);
      await row(17).locator('.danger').click();
      await page.getByRole('dialog').getByRole('button', { name: await label('editor.block.deleteConfirm'), exact: true }).click();
      assert.deepEqual(await order(), original.slice(0, -1));
      // Preview/back must retain selection and the block-list scroll position.
      await row(12).locator('.block-select').click();
      const open = page.getByRole('button', { name: await label('editor.actions.openViewer'), exact: true });
      await open.scrollIntoViewIfNeeded();
      const scroll = await page.locator('.block-list').evaluate(el => { el.scrollTop = 150; return el.scrollTop; });
      await open.click();
      await page.locator('.viewer-back-to-editor').waitFor();
      await page.locator('.viewer-back-to-editor').click();
      await page.waitForFunction(() => window.editorSession?.state.selectedBlockId === 'nav-12');
      await page.waitForFunction(expected => Math.abs(document.querySelector('.block-list').scrollTop - expected) <= 1, scroll);
      assert.equal(await row(12).evaluate(el => el.classList.contains('selected')), true);
      assert.deepEqual(await order(), original.slice(0, -1));
      assert.deepEqual(errors, []);
      console.log(`PASS navigation lifecycle ${locale} ${width}: disposal, stale moves, delete and preview return`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
