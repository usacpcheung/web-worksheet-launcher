import assert from 'node:assert/strict';
import { chromium } from 'playwright';
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
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { ready: true, user: { sub: 'fixture' }, items: [] } } }));
      await page.goto(`${base}/server/editor/?localDraftId=metadata-status`);
      await page.waitForFunction(() => window.editorSession);
      const fixture = await page.evaluate(async () => {
        const session = window.editorSession;
        clearTimeout(session.autosaveTimer);
        session.state.draft.title = 'Metadata fixture';
        session.state.draft.metadata.subject = 'Science 科學';
        session.state.draft.blocks = [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Describe 科學' }, responseConfig: { inputType: 'text' } }];
        session.state.draftRevision++;
        await session.autosave();
        const bytes = await session.buildCurrentDraftPackageZipBytes();
        return { bytes: Array.from(bytes), savedAt: session.state.lastSavedAt };
      });
      await page.reload();
      await page.waitForFunction(() => window.editorSession);
      assert.equal(await page.evaluate(() => window.editorSession.state.lastSavedAt), fixture.savedAt);
      const topbar = await page.locator('.editor-topbar').innerText();
      assert.ok(!topbar.includes('Not yet saved'));
      assert.ok(!topbar.includes('尚未儲存'));
      // A failed save must retain the previous successful timestamp.
      await page.evaluate(async savedAt => {
        const session = window.editorSession;
        const put = session.storage.drafts.put;
        session.storage.drafts.put = async () => { throw new Error('QA synthetic persistence failure'); };
        session.state.draftRevision++;
        try { await session.autosave(); } catch (error) {
          if (error.message !== "QA synthetic persistence failure") throw error;
        }
        if (session.state.lastSavedAt !== savedAt || !session.state.lastPersistenceError) throw new Error('Incorrect failed-save status');
        session.storage.drafts.put = put;
        await session.autosave();
      }, fixture.savedAt);
      if (shots) await page.screenshot({ path: `${shots}/editor-${locale}-${width}.png` });
      // Import the actual editor ZIP, then boot the ordinary viewer route.
      const importedId = await page.evaluate(async bytes => {
        const { parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
        const { viewerStorage } = await import('/server/viewer/storage/index.js');
        const parsed = parseWorksheetPackage(new Uint8Array(bytes));
        const id = 'metadata-import';
        await viewerStorage.importedWorksheets.put({ localId: id, worksheet: parsed.worksheet, metadata: { localId: id, origin: 'imported_file', updatedAt: new Date().toISOString() } });
        return id;
      }, fixture.bytes);
      await page.goto(`${base}/server/viewer/?importedWorksheetId=${importedId}`);
      await page.waitForFunction(() => window.viewerSession?.state.viewerPayload);
      const inProgressLabel = await page.evaluate(async () => (await import('/server/app/i18n/index.js')).t('viewer.status.inProgress'));
      assert.ok((await page.locator('.answer-summary:visible').innerText()).includes(inProgressLabel));
      const results = await page.evaluate(async () => {
        const s = window.viewerSession;
        const { t } = await import('/server/app/i18n/index.js');
        s.setAnswer('q1', 'Preserved 答案');
        await s.autosave();
        await s.completeLocalAttempt();
        const pkg = await s.buildUploadedAttemptPackage();
        await s.importAttemptPackageFromFile(pkg.bytes);
        return { subject: s.state.sourceSubject, answer: s.state.answers.q1.value, status: s.state.status,
          detailsLabel: t('viewer.details.openTechnicalDetailsAriaLabel'), idLabel: t('viewer.details.localAttemptId'), completed: t('viewer.status.completed') };
      });
      assert.equal(results.subject, 'Science 科學');
      assert.equal(results.answer, 'Preserved 答案');
      assert.equal(results.status, 'completed');
      assert.ok((await page.locator('.answer-summary:visible').innerText()).includes(results.completed));
      await page.getByRole('button', { name: results.detailsLabel, exact: true }).click();
      assert.ok((await page.locator('.viewer-details-modal').innerText()).includes(results.idLabel));
      if (locale === 'zh-Hant') {
        assert.ok(!(await page.locator('.viewer-details-modal').innerText()).includes('Local attempt ID'));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      if (shots) await page.screenshot({ path: `${shots}/viewer-${locale}-${width}.png` });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log('PASS: editor ZIP subject, viewer attempt round trip, restored save time, failed-save status and localized UI at desktop/mobile widths');
} finally { await browser.close(); }
