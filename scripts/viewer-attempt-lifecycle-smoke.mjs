import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) {
    const context = await browser.newContext({ viewport: { width: locale === 'en' ? 1280 : 390, height: 900 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ status: 401, json: { ok: false, error: { code: 'AUTH_REQUIRED' } } }));
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${base}/server/viewer/`);
      await page.evaluate(async () => {
        const { viewerStorage: storage } = await import('/server/viewer/storage/index.js');
        const now = new Date().toISOString();
        for (const id of ['a', 'b']) await storage.drafts.put({ localId: id, title: 'Worksheet '+id,
          blocks: [{ blockId: 'q', kind: 'question', position: 0, prompt: { text: 'Answer '+id }, responseConfig: { inputType: 'text', maxLength: 200 } }],
          metadata: { localId: id, origin: 'editor', updatedAt: now } });
      });
      await page.goto(`${base}/server/viewer/?localDraftId=a`);
      await page.waitForFunction(() => window.viewerSession?.state.localAttemptId);
      const a = await page.evaluate(async () => { viewerSession.setAnswer('q', 'Keep A'); await viewerSession.autosave(); return viewerSession.state.localAttemptId; });
      const resume = () => page.evaluate(() => JSON.parse(localStorage.getItem('worksheetLauncher:resumeFlags'))?.['viewer:lastSession']?.localId);
      assert.equal(await resume(), a);
      // Preview is an explicit new session, even for the same draft/version.
      await page.goto(`${base}/server/viewer/?localDraftId=b&preview=1`);
      await page.locator('.viewer-preview-strip').waitFor();
      const preview = await page.evaluate(async () => { viewerSession.setAnswer('q', 'Test B'); await viewerSession.autosave(); return viewerSession.state.localAttemptId; });
      await page.evaluate(() => viewerSession.lifecycle.authStorage().resumeFlags.set('viewer:lastSession', { localId: viewerSession.state.localAttemptId, store: 'localAttempts' }));
      assert.equal(await resume(), a);
      assert.equal(await page.evaluate(async () => (await viewerSession.exportCurrentAttemptPackage()).error.code), 'PREVIEW_ACTION_DISABLED');
      assert.equal(await page.evaluate(async () => (await viewerSession.uploadCurrentAttemptPackage()).error.code), 'PREVIEW_ACTION_DISABLED');
      await page.reload(); await page.locator('.viewer-preview-strip').waitFor();
      assert.equal(await page.evaluate(() => viewerSession.state.answers.q.value), 'Test B');
      assert.equal(await page.evaluate(() => viewerSession.state.localAttemptId), preview);
      assert.equal(await resume(), a);
      // Submission/printing still work, and restart clears the disposable answers.
      await page.evaluate(async () => { viewerSession.state.studentNameResolved = true; await viewerSession.completeLocalAttempt(); });
      await page.waitForFunction(() => viewerSession.state.status === 'completed');
      assert.equal(await page.locator('[aria-describedby=viewer-print-hint]').getAttribute('aria-disabled'), 'false');
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) await page.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/preview-${locale}.png` });
      await page.locator('.viewer-preview-strip button').click();
      await page.locator('.viewer-attempt-dialog button[type=submit]').click();
      await page.waitForFunction(id => viewerSession.state.localAttemptId !== id, preview);
      assert.equal(await page.evaluate(() => viewerSession.state.status), 'in_progress');
      assert.deepEqual(await page.evaluate(() => viewerSession.state.answers), {});
      assert.equal(await resume(), a);
      await page.goto(`${base}/server/viewer/?localDraftId=b&preview=1`);
      await page.locator('.viewer-preview-strip').waitFor();
      assert.notEqual(await page.evaluate(() => viewerSession.state.localAttemptId), preview);
      assert.deepEqual(await page.evaluate(() => viewerSession.state.answers), {});
      // Normal opening requires confirmation and Cancel preserves A.
      await page.goto(`${base}/server/viewer/?localDraftId=b`);
      await page.locator('.viewer-attempt-dialog').waitFor();
      assert.equal(await resume(), a);
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) await page.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/replacement-${locale}.png` });
      await page.locator('.viewer-attempt-dialog button[type=button]').click();
      await page.locator('.viewer-resume-card').waitFor();
      assert.equal(await resume(), a);
      assert.equal(new URL(page.url()).search, '');
      await page.goto(`${base}/server/viewer/?localDraftId=b`);
      await page.locator('.viewer-attempt-dialog button[type=submit]').click();
      await page.waitForFunction(() => window.viewerSession?.state.localAttemptId);
      const b = await page.evaluate(() => viewerSession.state.localAttemptId);
      assert.notEqual(b, a); assert.equal(await resume(), b);
      await page.evaluate(async () => { viewerSession.setAnswer('q', 'B answer'); await viewerSession.completeLocalAttempt(); });
      await page.reload(); await page.waitForFunction(() => window.viewerSession?.state.status === 'completed');
      assert.equal(await page.evaluate(() => viewerSession.state.localAttemptId), b);
      // Explicitly opening even the same submitted worksheet starts fresh.
      await page.goto(`${base}/server/viewer/?localDraftId=b`);
      await page.locator('.viewer-attempt-dialog button[type=submit]').click();
      await page.waitForFunction(() => window.viewerSession?.state.localAttemptId);
      assert.equal(await page.evaluate(() => viewerSession.state.status), 'in_progress');
      assert.notEqual(await page.evaluate(() => viewerSession.state.localAttemptId), b);
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale}: preview isolation, refresh, fresh preview, action guards, replacement Cancel/accept, submitted same-worksheet reopening`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
