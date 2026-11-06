import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8766';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant'])
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await context.route(
        (u) => u.pathname.startsWith('/api/'),
        (r) => r.fulfill({ json: { ok: true, data: { items: [] } } })
      );
      await page.addInitScript((l) => localStorage.setItem('worksheetLauncher.locale', l), locale);
      await page.goto(base + '/server/editor/');
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(() => {
        const s = editorSession;
        s.state.draft.title = 'Image budget fixture';
        s.state.draft.blocks = [];
        for (let i = 0; i < 3; i++) {
          s.createBlock('question');
          s.updateQuestionInputType(s.state.selectedBlockId, 'image_response');
        }
        s.notifyStateChange();
      });
      await page.locator('#editor-max-images').selectOption('2');
      const result = await page.evaluate(async () => {
        const s = editorSession;
        await s.saveNow();
        const { parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
        const parsed = parseWorksheetPackage(await s.buildCurrentDraftPackageZipBytes());
        return {
          version: parsed.manifest.packageVersion,
          counts: parsed.worksheet.blocks.map((b) => b.responseConfig.maxImages),
        };
      });
      assert.equal(result.version, 5);
      assert.deepEqual(result.counts, [3, 3, 2]);
      await page.evaluate(() => {
        editorSession.createBlock('question');
        editorSession.notifyStateChange();
      });
      assert(await page.locator('#editor-question-input-type option[value="image_response"]').isDisabled());
      // Budget uses real persisted bytes, not absent/stale draft metadata.
      await page.evaluate(async () => {
        const s = editorSession,
          now = new Date().toISOString();
        await s.storage.localAssets.put({
          localId: 'large',
          binary: new Uint8Array(15 * 1048576),
          metadata: {
            localId: 'large',
            origin: 'local_source',
            updatedAt: now,
          },
        });
        s.state.draft.assets.push({
          assetId: 'large',
          kind: 'image',
          mimeType: 'image/png',
          path: 'media/large',
        });
        s.touchDraft();
        s.notifyStateChange();
      });
      await page
        .waitForFunction(
          () => [...document.querySelectorAll('.control-error')].some((n) => n.textContent.includes('30 MB')),
          null,
          { timeout: 5000 }
        )
        .catch(async (e) => {
          console.log(await page.locator('body').innerText());
          throw e;
        });
      const rejected = await page.evaluate(async () => {
        try {
          await editorSession.buildCurrentDraftPackageZipBytes();
          return false;
        } catch (e) {
          return e.code === 'IMAGE_PACKAGE_BUDGET';
        }
      });
      assert(rejected);
      assert.deepEqual(errors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      console.log('PASS editor image count/configuration/actual-byte budget', locale, width);
      await context.close();
    }
} finally {
  await browser.close();
}
