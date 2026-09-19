import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
      await page.goto(base + '/server/editor/index.html');
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(async locale => {
        const { setLocale } = await import('/server/app/i18n/index.js');
        setLocale(locale);
        const s = window.editorSession;
        s.state.draft.blocks = Array.from({ length: 18 }, (_, i) => ({ blockId: `drag-${i}`, position: i,
          kind: i < 4 ? 'content' : 'question', ...(i < 4
            ? { content: { text: `Content ${i}`, format: 'plain_text' } }
            : { prompt: { text: `Question ${i}`, format: 'plain_text' }, responseConfig: { inputType: 'text', maxLength: 200 } }) }));
        s.state.selectedBlockId = 'drag-0';
        s.touchDraft();
        window.dragOriginal = structuredClone(s.state.draft.blocks);
        await s.saveBeforeWorksheetReplacement();
      }, locale);
      const list = page.locator('.block-list');
      const row = id => page.locator(`[data-block-id="drag-${id}"]`);
      const order = () => page.evaluate(() => window.editorSession.state.draft.blocks.map(b => b.blockId));
      const start = async id => {
        await list.scrollIntoViewIfNeeded();
        const handle = row(id).locator('.block-drag-handle');
        await handle.scrollIntoViewIfNeeded();
        await list.evaluate(el => el.scrollIntoView({ block: 'center' }));
        const rect = await handle.boundingBox();
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.mouse.down();
        await page.mouse.move(rect.x + rect.width / 2 + 10, rect.y + rect.height / 2 + 6, { steps: 5 });
        await page.waitForFunction(() => !!document.querySelector('.block-item--dragging'));
      };
      await start(0);
      const bounds = await list.boundingBox();
      // Chromium needs a second move to deliver dragover after entering a new
      // target; repeat after scrolling too, when a different row is under it.
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 3, { steps: 8 });
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 3);
      // Real autosave completion while dragging must not detach the native source.
      await page.evaluate(() => window.editorSession.autosave());
      assert.equal(await row(0).evaluate(el => el.classList.contains('block-item--dragging')), true);
      await page.waitForFunction(() => { const el = document.querySelector('.block-list'); return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; });
      if (shots) await page.screenshot({ path: `${shots}/drag-end-${locale}-${width}.png` });
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 3);
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 3);
      await page.mouse.up();
      await page.waitForFunction(() => window.editorSession.state.draft.blocks.at(-1).blockId === 'drag-0');
      assert.equal(await row(0).locator('.block-drag-handle').evaluate(el => document.activeElement === el), true);
      await start(0);
      const topBounds = await list.boundingBox();
      await page.mouse.move(topBounds.x + topBounds.width / 2, Math.max(0, topBounds.y) + 3, { steps: 8 });
      await page.mouse.move(topBounds.x + topBounds.width / 2, Math.max(0, topBounds.y) + 3);
      await page.waitForFunction(() => document.querySelector('.block-list').scrollTop <= 1);
      await page.mouse.move(topBounds.x + topBounds.width / 2, Math.max(0, topBounds.y) + 3);
      await page.mouse.move(topBounds.x + topBounds.width / 2, Math.max(0, topBounds.y) + 3);
      await page.mouse.up();
      await page.waitForFunction(() => window.editorSession.state.draft.blocks[0].blockId === 'drag-0');
      const before = await order();
      await start(0);
      const cancelBounds = await list.boundingBox();
      await page.mouse.move(cancelBounds.x + cancelBounds.width / 2, cancelBounds.y + cancelBounds.height - 3, { steps: 8 });
      await page.mouse.move(Math.max(0, cancelBounds.x - 12), cancelBounds.y + 100, { steps: 4 });
      const stopped = await list.evaluate(el => el.scrollTop);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
      assert.equal(await list.evaluate(el => el.scrollTop), stopped, 'leaving list stops explicit scrolling');
      await page.keyboard.press('Escape');
      await page.mouse.up();
      assert.deepEqual(await order(), before, 'cancel/outside release does not move a block');
      assert.equal(await page.locator('.block-item--dragging, .block-item--drop-before, .block-item--drop-after').count(), 0);
      // Exercise a drop in the actual 10px gap, not on a row.
      await list.evaluate(el => { el.scrollTop = 0; });
      await start(0);
      const next = await row(2).boundingBox();
      await page.mouse.move(next.x + next.width / 2, next.y - 4, { steps: 8 });
      await page.mouse.move(next.x + next.width / 2, next.y - 4);
      await page.mouse.up();
      await page.waitForFunction(() => window.editorSession.state.draft.blocks[1].blockId === 'drag-0');
      assert.equal(await page.evaluate(() => window.editorSession.state.draft.blocks.every((b, i) => {
        const original = window.dragOriginal.find(entry => entry.blockId === b.blockId);
        return b.position === i && JSON.stringify({ ...b, position: 0 }) === JSON.stringify({ ...original, position: 0 });
      })), true);
      const expected = await order();
      await page.evaluate(() => window.editorSession.saveBeforeWorksheetReplacement());
      await page.reload();
      await page.waitForFunction(() => window.editorSession?.state.draft?.blocks.length === 18);
      assert.deepEqual(await order(), expected, 'drag order persists');
      // Synthetic events supplement native drags for asynchronous state changes.
      for (const change of ['external', 'order', 'draft']) {
        const result = await page.evaluate(change => {
          const s = window.editorSession;
          const list = document.querySelector('.block-list');
          const transfer = new DataTransfer();
          if (change !== 'external') list.querySelector('.block-drag-handle').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
          if (change === 'order') s.reorderBlockToIndex(s.state.draft.blocks[0].blockId, 2);
          if (change === 'draft') { s.state.draft.localId += '-replacement'; s.touchDraft(); }
          const before = s.state.draft.blocks.map(b => b.blockId);
          const rect = list.getBoundingClientRect();
          const init = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.x + 40, clientY: rect.y + 5 };
          list.dispatchEvent(new DragEvent('dragover', init));
          list.dispatchEvent(new DragEvent('drop', init));
          return { before, after: s.state.draft.blocks.map(b => b.blockId), markers: list.querySelectorAll('.block-item--dragging, .block-item--drop-before, .block-item--drop-after').length };
        }, change);
        assert.deepEqual(result.after, result.before, `${change} cannot apply a stale/unrelated drop`);
        assert.equal(result.markers, 0);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale} ${width}: native drag both ends, autosave, gap, cancellation, focus and reload`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
