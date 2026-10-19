// Isolated transport simulation: exercise real API recovery and UI cancel controls.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const app of ['editor', 'viewer']) for (const locale of ['en', 'zh-Hant']) {
    const context = await browser.newContext({ viewport: { width: locale === 'en' ? 1280 : 390, height: 900 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let posts = 0, lookups = 0, releaseLookup;
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/session')) return route.fulfill({ json: { ok: true, data: { ready: true, user: { sub: 'fixture' } } } });
        if (url.pathname.includes('/upload-operations/')) {
          lookups++;
          // Keep the receipt request pending until after the UI has canceled.
          await new Promise(resolve => { releaseLookup = resolve; });
          await route.fulfill({ json: { ok: true, data: { operationId: url.pathname.split('/').pop(), state: 'unknown' } } }).catch(() => {});
          return;
        }
        if (route.request().method() === 'POST') { posts++; return route.abort('failed'); }
        return route.fulfill({ json: { ok: true, data: { items: [] } } });
      });
      await page.goto(`${base}/server/${app}/`);
      if (app === 'viewer') {
        await page.evaluate(async () => {
          const { viewerStorage } = await import('/server/viewer/storage/index.js');
          const now = new Date().toISOString();
          await viewerStorage.attempts.put({ localId: 'cancel-ui', localAttemptId: 'cancel-ui', status: 'in_progress', startedAt: now,
            viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', title: 'Cancel fixture', blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Question' }, responseConfig: { inputType: 'text' } }] },
            answers: { q1: { value: 'Keep this answer' } }, metadata: { localId: 'cancel-ui', origin: 'local_source', updatedAt: now } });
        });
        await page.goto(`${base}/server/viewer/?localAttemptId=cancel-ui`);
      }
      await page.waitForFunction(app => Boolean(window[`${app}Session`]?.state), app);
      if (app === 'editor') await page.locator('details').filter({ has: page.locator('[data-upload-cancel="editor"]') }).locator('summary').click();
      // Use the actual input so revision tracking protects the edit from an
      // older in-flight autosave. Direct state assignment bypasses that contract.
      if (app === 'editor') await page.locator('#editor-title-input').fill('Preserve this draft');
      const expected = await page.evaluate(async app => {
        const session = window[`${app}Session`];
        const { createServerApiClient } = await import('/server/app/api/server-api-client.js');
        const { t } = await import('/server/app/i18n/index.js');
        session.apiClient = createServerApiClient();
        await session.refreshServerSession();
        window.cancelTestDone = false;
        // Invoke the real upload method, then cancel through the rendered control.
        const upload = app === 'editor' ? session.uploadCurrentDraftToServer() : session.uploadCurrentAttemptPackage();
        upload.then(result => { window.cancelTestResult = result; window.cancelTestDone = true; });
        return t('apiErrors.uploadCanceled');
      }, app);
      assert.match(expected, locale === 'en' ? /server may already have saved/ : /伺服器可能已儲存/);
      for (let i = 0; !releaseLookup && i < 100; i++) await page.waitForTimeout(50);
      assert.ok(releaseLookup, 'receipt request must be in flight before cancel');
      await page.locator(`[data-upload-cancel="${app}"]`).click();
      await page.waitForFunction(() => window.cancelTestDone, null, { timeout: 2000 });
      assert.equal(await page.evaluate(() => window.cancelTestResult.error.code), 'ABORTED');
      assert.equal(await page.evaluate(app => window[`${app}Session`].state.serverActionMessage, app), expected);
      await page.getByText(expected, { exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 2000 });
      const countAtCancel = lookups;
      releaseLookup();
      await page.waitForTimeout(5500);
      assert.equal(await page.evaluate(app => window[`${app}Session`].state.serverActionMessage, app), expected, 'late receipt cannot overwrite cancellation');
      assert.equal(posts, 1, 'no automatic re-upload');
      assert.equal(lookups, countAtCancel, 'no receipt polling after cancellation');
      assert.equal(await page.locator(`[data-upload-cancel="${app}"]`).isVisible(), false);
      assert.equal(await page.evaluate(app => app === 'editor' ? window.editorSession.state.draft.title : window.viewerSession.state.answers.q1.value, app), app === 'editor' ? 'Preserve this draft' : 'Keep this answer');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log('PASS: editor/viewer in-flight recovery cancellation localized in both languages; no retry, controls released, local content preserved');
} finally { await browser.close(); }
