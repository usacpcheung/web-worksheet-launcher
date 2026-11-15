import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [], downloads = [], uploads = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('download', download => downloads.push(download));
      await context.route(url => url.pathname.startsWith('/api/'), route => {
        if (route.request().method() === 'POST') uploads.push(route.request().url());
        return route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } });
      });
      await page.goto(base + '/server/editor/');
      await page.waitForFunction(() => window.editorSession);
      await page.locator('.language-selector__control').selectOption(locale);
      const labels = await page.evaluate(async () => {
        const { t } = await import('/server/app/i18n/index.js');
        const s = window.editorSession;
        s.state.draft.blocks = [
          { blockId: 'reading', kind: 'content', position: 0, content: { text: '' } },
          { blockId: 'q', kind: 'question', position: 1, prompt: { text: 'Question' }, responseConfig: { inputType: 'text', maxLength: 200 } },
        ];
        s.selectBlock('q'); s.touchDraft(); s.notifyStateChange();
        return { export: t('editor.actions.exportPackage'), preview: t('editor.actions.openViewer'), upload: t('editor.server.uploadDraft') };
      });
      const startingUrl = page.url();
      for (const action of ['export', 'preview']) {
        await page.getByRole('button', { name: labels[action], exact: true }).click();
        assert.equal(page.url(), startingUrl);
        assert.equal(await page.evaluate(() => window.editorSession.state.selectedBlockId), 'reading');
        assert.match(await page.evaluate(() => window.editorSession.state.notifications.at(-1).text), locale === 'en' ? /Enter some text or delete/ : /輸入文字或刪除/);
      }
      await page.getByRole('button', { name: labels.upload, exact: true, includeHidden: true }).evaluate(button => {
        const details = button.closest('details'); if (details) details.open = true;
      });
      await page.getByRole('button', { name: labels.upload, exact: true }).click();
      assert.equal(uploads.length, 0);
      assert.equal(downloads.length, 0);
      // Autosave/reload retains incomplete work, then fixing it allows export.
      const localId = await page.evaluate(async () => {
        const s = window.editorSession;
        await s.saveNow();
        return s.state.draft.localId;
      });
      await page.goto(`${base}/server/editor/?localDraftId=${encodeURIComponent(localId)}`);
      await page.waitForFunction(() => window.editorSession?.state.draft);
      assert.equal(await page.evaluate(() => window.editorSession.state.draft.blocks[0].content.text), '');
      await page.evaluate(() => {
        const s = window.editorSession;
        s.updateBlockContent('reading', 'Read this first.');
        s.notifyStateChange();
      });
      assert.equal(await page.evaluate(() => window.editorSession.validateCurrentDraft().valid), true);
      // Real ZIP producer + reader/viewer contract, not a stubbed download.
      assert.equal(await page.evaluate(async () => {
        const s = window.editorSession;
        const { parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
        const { validateViewerPayloadSchema } = await import('/server/app/contracts/validators.js');
        const pkg = parseWorksheetPackage(await s.buildCurrentDraftPackageZipBytes());
        return validateViewerPayloadSchema({ ...pkg.worksheet, worksheetId: 'w', snapshotId: 's' }).valid;
      }), true);
      await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: labels.export, exact: true }).click()]);
      assert.equal(downloads.length, 1);
      assert.deepEqual(errors, []);
      console.log(`PASS readiness ${locale} ${width}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
