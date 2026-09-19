// Isolated local worksheet; session API is synthetic. No production records.
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
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
      await page.goto(base + '/server/editor/index.html');
      await page.waitForFunction(() => window.editorSession);
      const labels = await page.evaluate(async locale => {
        const { setLocale, t } = await import('/server/app/i18n/index.js');
        setLocale(locale);
        const session = window.editorSession;
        session.state.draft.blocks = Array.from({ length: 18 }, (_, i) => ({
          blockId: `reorder-${i}`, position: i, kind: i < 4 ? 'content' : 'question',
          ...(i < 4 ? { content: { text: `Content ${i}`, format: 'plain_text' } }
            : { prompt: { text: `Question ${i}`, format: 'plain_text' }, responseConfig: { inputType: 'text', maxLength: 200 } }),
        }));
        session.state.selectedBlockId = 'reorder-0';
        session.touchDraft();
        session.notifyStateChange();
        window.reorderOriginal = structuredClone(session.state.draft.blocks);
        return Object.fromEntries(['beginning', 'end', 'position', 'move'].map(key => [key, t(`editor.reorder.${key}`)]));
      }, locale);
      const row = id => page.locator(`.block-item[data-block-id="reorder-${id}"]`);
      const menu = () => page.locator('.block-reorder-menu');
      const order = () => page.evaluate(() => window.editorSession.state.draft.blocks.map(block => block.blockId));
      const open = async id => { await row(id).locator('.block-reorder-trigger').click(); await menu().waitFor(); };
      await open(0);
      await page.evaluate(() => window.editorSession.autosave());
      await menu().waitFor({ state: 'detached' });
      assert.equal(await row(0).locator('.block-reorder-trigger').evaluate(el => el === document.activeElement), true,
        'autosave restores focus to the rebuilt menu trigger');
      await page.keyboard.press('Enter');
      await menu().waitFor();
      await page.evaluate(() => window.editorSession.notifyStateChange());
      assert.equal(await row(0).locator('.block-reorder-trigger').evaluate(el => el === document.activeElement), true,
        'other background refreshes preserve the keyboard continuation point');
      await open(0);
      assert.equal(await menu().getByRole('menuitem', { name: labels.beginning, exact: true }).isDisabled(), true);
      await menu().getByRole('menuitem', { name: labels.end, exact: true }).click();
      assert.equal((await order()).at(-1), 'reorder-0');
      await page.keyboard.press('Control+Shift+ArrowDown');
      assert.equal((await order()).at(-1), 'reorder-0', 'last-position shortcut is a no-op');
      assert.equal(await row(0).locator('.block-reorder-trigger').evaluate(el => el === document.activeElement), true);
      assert.equal(await row(0).evaluate(el => { const a = el.getBoundingClientRect(), b = el.parentElement.getBoundingClientRect(); return a.top >= b.top - 1 && a.bottom <= b.bottom + 1; }), true);
      await open(0);
      await menu().getByRole('menuitem', { name: labels.position, exact: true }).click();
      const dialog = page.locator('.editor-block-position-dialog');
      await dialog.waitFor();
      assert.equal(await dialog.evaluate(el => { const rect = el.getBoundingClientRect(); return rect.left >= 15 && rect.right <= innerWidth - 15; }), true, 'dialog keeps mobile gutters');
      assert.equal(await dialog.locator('select option').count(), 18);
      await dialog.locator('select').selectOption({ value: '8' });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal((await order()).at(-1), 'reorder-0');
      await open(0);
      await menu().getByRole('menuitem', { name: labels.position, exact: true }).click();
      await dialog.locator('select').selectOption({ value: '8' });
      if (shots) await page.screenshot({ path: `${shots}/reorder-position-${locale}-${width}.png` });
      await dialog.getByRole('button', { name: labels.move, exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal((await order())[8], 'reorder-0', JSON.stringify(await order()));
      await page.keyboard.press('Control+Shift+ArrowUp');
      await page.keyboard.press('Control+Shift+ArrowUp');
      assert.equal((await order())[6], 'reorder-0');
      await page.keyboard.press('Meta+Shift+ArrowDown');
      assert.equal((await order())[7], 'reorder-0');
      await open(0);
      await page.keyboard.press('Home');
      assert.equal(await menu().getByRole('menuitem').first().evaluate(el => document.activeElement === el), true);
      await page.keyboard.press('Escape');
      assert.equal(await row(0).locator('.block-reorder-trigger').evaluate(el => document.activeElement === el), true);
      await open(0);
      await menu().getByRole('menuitem', { name: labels.beginning, exact: true }).click();
      await page.keyboard.press('Control+Shift+ArrowUp');
      assert.equal((await order())[0], 'reorder-0');
      const before = await order();
      const text = page.locator('textarea:visible').first();
      await text.focus();
      await page.evaluate(() => window.editorSession.notifyStateChange());
      assert.equal(await text.evaluate(el => document.activeElement === el), true,
        'background updates do not steal focus from the detail editor');
      await page.keyboard.press('Control+Shift+ArrowDown');
      assert.deepEqual(await order(), before, 'text-field shortcuts do not move blocks');
      assert.equal(await page.evaluate(() => {
        const session = window.editorSession;
        return session.state.selectedBlockId === 'reorder-0' && session.state.draft.blocks.every((block, i) => {
          const original = window.reorderOriginal.find(entry => entry.blockId === block.blockId);
          return block.position === i && JSON.stringify({ ...block, position: 0 }) === JSON.stringify({ ...original, position: 0 });
        });
      }), true, 'selection, IDs and all block data survive');
      await page.evaluate(() => window.editorSession.saveBeforeWorksheetReplacement());
      const draftId = await page.evaluate(() => window.editorSession.state.draft.localId);
      await page.goto(base + '/server/editor/index.html?localDraftId=' + encodeURIComponent(draftId));
      await page.waitForFunction(() => window.editorSession?.state.draft?.blocks.length === 18);
      assert.deepEqual(await order(), before, 'order survives save/reload');
      await open(0);
      await menu().getByRole('menuitem', { name: labels.position, exact: true }).click();
      await page.evaluate(() => window.editorSession.reorderBlockToIndex('reorder-1', 4));
      const changedOrder = await order();
      await dialog.locator('select').selectOption({ value: '5' });
      await dialog.getByRole('button', { name: labels.move, exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.deepEqual(await order(), changedOrder, 'stale dialog cannot reorder a changed sequence');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale} ${width}: 18 blocks, endpoints, position/cancel, shortcuts, focus, text isolation, data and reload`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
