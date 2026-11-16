import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const [locale, width] of [['en', 1280], ['zh-Hant', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ status: 401, json: { ok: false, error: { code: 'AUTH_REQUIRED' } } }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession);
      const fixture = await page.evaluate(async () => {
        const s = editorSession, storage = s.storage;
        const { t } = await import('/server/app/i18n/index.js');
        const metadata = localId => ({ localId, origin: 'editor', updatedAt: new Date().toISOString() });
        const ids = Array.from({ length: 32 }, (_, i) => `media-${i}`);
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vrcAAAAASUVORK5CYII='), c => c.charCodeAt(0));
        for (const id of ids) {
          const binary = new Uint8Array(256 * 1024); binary.set(png);
          await storage.localAssets.put({ localId: id, binary, metadata: { ...metadata(id), mimeType: 'image/png' } });
        }
        s.state.draft.title = '16-block cleanup fixture';
        s.state.draft.blocks = Array.from({ length: 16 }, (_, i) => ({
          blockId: `q-${i}`, kind: 'question', position: i,
          prompt: { text: `Question ${i + 1}`, mediaRefs: [{ usage: 'question_image', assetId: ids[i * 2] }] },
          responseConfig: { inputType: 'multiple_choice', selectionMode: 'single', options: [
            { id: 'a', value: 'a', label: 'A', mediaRefs: [{ usage: 'option_image', assetId: ids[i * 2 + 1] }] },
            { id: 'b', value: 'b', label: 'B' },
          ] },
        }));
        s.state.draft.assets = ids.map(assetId => ({ assetId, kind: 'image', mimeType: 'image/png' }));
        s.touchDraft(); await s.autosave(); s.notifyStateChange();
        const oldId = s.state.draft.localId;
        // All three retained record types must protect their shared media.
        await storage.drafts.put({ localId: 'other-draft', assets: [{ assetId: ids[0] }], metadata: metadata('other-draft') });
        await storage.importedWorksheets.put({ localId: 'source', assets: [{ assetId: ids[1] }], metadata: metadata('source') });
        await storage.attempts.put({ localId: 'attempt', answers: { image: { value: [{ assetId: ids[2] }] } }, metadata: metadata('attempt') });
        const collect = storage.localCleanup.collect;
        window.cleanupCalls = [];
        storage.localCleanup.collect = async options => {
          window.cleanupCalls.push(options.assetIds);
          if (window.cleanupCalls.length === 1) await new Promise(resolve => { window.finishCleanup = resolve; });
          return collect(options);
        };
        return { oldId, ids, start: t('editor.actions.startNewWorksheet'), creating: t('editor.packageLoad.creating'), confirm: t('editor.newWorksheet.confirmLabel') };
      });
      const button = page.getByRole('button', { name: fixture.start, exact: true });
      await button.click();
      await page.locator('.confirm-modal').getByRole('button', { name: fixture.confirm, exact: true }).click();
      await page.waitForFunction(() => window.finishCleanup);
      const busy = page.getByRole('button', { name: fixture.creating, exact: true });
      assert.equal(await busy.isDisabled(), true);
      assert.equal(await busy.getAttribute('aria-busy'), 'true');
      const status = page.locator('.editor-panel.left > [data-editor-load-status]');
      assert.equal(await status.innerText(), fixture.creating);
      await busy.scrollIntoViewIfNeeded();
      const bounds = await busy.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.equal(await busy.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      assert.equal(await page.evaluate(() => editorSession.createRecoveryRecord()), null);
      assert.equal(await page.evaluate(() => editorSession.state.draft.localId), fixture.oldId);
      assert.deepEqual(await page.evaluate(() => window.cleanupCalls), [fixture.ids]);
      assert.equal(await page.evaluate(() => editorSession.startNewWorksheet()), null, 'duplicate reset stays locked');
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) await page.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/creating-${locale}.png` });
      await page.evaluate(() => window.finishCleanup());
      await page.waitForFunction(id => !editorSession.packageLoad.current && editorSession.state.draft.localId !== id, fixture.oldId);
      assert.equal(await button.isEnabled(), true);
      assert.equal(await button.getAttribute('aria-busy'), 'false');
      assert.equal(await status.isHidden(), true);
      assert.deepEqual(await page.evaluate(async () => (await editorSession.storage.localAssets.list()).map(a => a.localId).sort()), fixture.ids.slice(0, 3));
      assert.equal(await page.evaluate(id => editorSession.storage.drafts.get(id).then(Boolean), fixture.oldId), false);
      // A failed required draft deletion restores the action and keeps the current work.
      const current = await page.evaluate(() => {
        const s = editorSession, remove = s.storage.drafts.remove;
        s.storage.drafts.remove = async () => { s.storage.drafts.remove = remove; throw Error('QA deletion failed'); };
        return s.state.draft.localId;
      });
      await button.click();
      await page.locator('.confirm-modal').getByRole('button', { name: fixture.confirm, exact: true }).click();
      await page.waitForFunction(() => !editorSession.packageLoad.current);
      assert.equal(await button.isEnabled(), true);
      assert.equal(await status.isHidden(), true);
      assert.equal(await page.evaluate(() => editorSession.state.draft.localId), current);
      assert.ok(await page.evaluate(() => editorSession.createRecoveryRecord()));
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale} ${width}: 16 blocks/32 media, one cleanup scan, visible busy state, shared assets retained, failed reset recovers`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
