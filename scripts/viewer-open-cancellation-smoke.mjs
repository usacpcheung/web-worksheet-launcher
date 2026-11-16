import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createWorksheetPackageFromDraft } from '../server/editor/worksheet-package.js';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const draft = { title: 'Cancellation fixture', blocks: [{ blockId: 'q', kind: 'question', position: 0,
  prompt: { text: 'Keep the image', mediaRefs: [{ usage: 'question_image', assetId: 'img' }] }, responseConfig: { inputType: 'text' } }],
  assets: [{ assetId: 'img', path: 'media/img.png', kind: 'image', usage: 'question_image', mimeType: 'image/png' }] };
const worksheet = createWorksheetPackageFromDraft(draft, new Map([['img', { binary: png }]])).bytes;
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) {
    const context = await browser.newContext({ viewport: { width: locale === 'en' ? 1280 : 390, height: 900 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await context.route(url => url.pathname.startsWith('/api/'), route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/session')) return route.fulfill({ json: { ok: true, data: { ready: true, user: { sub: 'fixture' } } } });
        if (path.endsWith('/artifact')) return route.fulfill({ contentType: 'application/zip', body: Buffer.from(worksheet) });
        return route.fulfill({ json: { ok: true, data: { items: Array.from({ length: 6 }, (_, i) => ({ published_package_id: `package-${i}`, title: `Worksheet ${i}`, subject: 'QA' })) } } });
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const resume = () => page.evaluate(() => JSON.parse(localStorage.getItem('worksheetLauncher:resumeFlags'))['viewer:lastSession'].localId);
      await page.goto(`${base}/server/viewer/`);
      await page.evaluate(async () => {
        const { viewerStorage: s } = await import('/server/viewer/storage/index.js');
        await s.attempts.put({ localId: 'keep-a', localAttemptId: 'keep-a', runtimeMode: 'normal', status: 'in_progress',
          viewerPayload: { worksheetId: 'a', snapshotId: 's', snapshotVersion: 1, title: 'Keep A', blocks: [{ blockId: 'q', kind: 'question', position: 0, prompt: { text: 'A' }, responseConfig: { inputType: 'text' } }] },
          answers: { q: { value: 'Keep my answer' } }, metadata: { localId: 'keep-a', origin: 'fixture', updatedAt: new Date().toISOString() } });
        s.resumeFlags.set('viewer:lastSession', { localId: 'keep-a', store: 'localAttempts' });
      });
      await page.reload();
      await page.getByRole('button', { name: await label('viewer.start.browsePublishedWorksheets'), exact: true }).click();
      const modal = page.locator('.viewer-published-browse-modal');
      const filter = modal.locator('input').first();
      const filtered = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/published') && new URL(r.url()).searchParams.get('title') === 'Worksheet');
      await filter.fill('Worksheet');
      await filtered;
      await modal.locator('.viewer-package-load-button').last().waitFor();
      // Hold cleanup before any storage work: the UI must settle without waiting for it.
      await page.evaluate(async () => {
        const { viewerStorage: s } = await import('/server/viewer/storage/index.js');
        const remove = s.importedWorksheets.remove;
        s.importedWorksheets.remove = async id => {
          if (!window.cancelledImport) {
            window.cancelledImport = id;
            await new Promise(resolve => { window.releaseCleanup = resolve; });
          }
          await remove(id);
          window.cleanupFinished = true;
        };
      });
      const open = modal.locator('.viewer-package-load-button').last();
      await open.click();
      await page.locator('.viewer-attempt-dialog').waitFor();
      const scroll = await modal.locator('.browse-results').evaluate(e => e.scrollTop);
      if (locale === 'zh-Hant') await page.keyboard.press('Escape');
      else await page.locator('.viewer-attempt-dialog button[type=button]').click();
      await page.waitForFunction(() => !!window.releaseCleanup);
      await page.waitForFunction(() => [...document.querySelectorAll('.viewer-package-load-button')].every(b => !b.disabled));
      assert.equal(await open.textContent(), await label('common.publishedBrowser.openPackage'));
      assert.equal(await open.evaluate(e => document.activeElement === e), true);
      assert.equal(await modal.locator('.browse-results').evaluate(e => e.scrollTop), scroll);
      assert.equal(await filter.inputValue(), 'Worksheet');
      assert.equal(await filter.isEnabled(), true);
      assert.equal(await modal.locator('.viewer-list-error:visible').count(), 0);
      assert.equal(await modal.locator('[role=status]').last().textContent(), await label('attemptLifecycle.cancelled'));
      assert.equal(await resume(), 'keep-a');
      assert.equal(await page.evaluate(() => !!window.cleanupFinished), false);
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) await page.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/cancel-${locale}.png` });
      // Reopen the same publication before old cleanup completes. Late cleanup
      // must never reset its progress, replace its answers, or remove its image.
      await open.click();
      await page.locator('.viewer-attempt-dialog button[type=submit]').click();
      await page.waitForFunction(() => window.viewerSession?.state.viewerPayload?.title === 'Cancellation fixture');
      const current = await resume(); assert.notEqual(current, 'keep-a');
      await page.evaluate(() => window.releaseCleanup());
      await page.waitForFunction(() => window.cleanupFinished);
      await page.waitForFunction(async () => {
        const s = viewerSession.storage;
        return !await s.importedWorksheets.get(window.cancelledImport) && (await s.localAssets.list()).length === 1;
      });
      assert.equal(await resume(), current);
      assert.equal(await page.locator('.viewer-list-error:visible, .viewer-fatal-panel').count(), 0);
      const attemptBytes = await page.evaluate(async () => [...(await viewerSession.buildUploadedAttemptPackage()).bytes]);
      for (const kind of ['worksheet', 'attempt']) {
        await page.goto(`${base}/server/viewer/`);
        await page.evaluate(async () => {
          const { viewerStorage: s } = await import('/server/viewer/storage/index.js');
          const remove = s.importedWorksheets.remove;
          s.importedWorksheets.remove = async id => {
            await new Promise(resolve => { window.releaseCleanup = resolve; });
            await remove(id); window.cleanupFinished = true;
          };
        });
        const key = kind === 'attempt' ? 'viewer.start.importAttemptPackage' : 'viewer.start.importPackage';
        const button = page.getByRole('button', { name: await label(key), exact: true });
        const choosing = page.waitForEvent('filechooser'); await button.click();
        await (await choosing).setFiles({ name: `${kind}.zip`, mimeType: 'application/zip', buffer: Buffer.from(kind === 'attempt' ? attemptBytes : worksheet) });
        await page.locator('.viewer-attempt-dialog button[type=button]').click();
        await page.waitForFunction(() => !!window.releaseCleanup);
        await page.waitForFunction(() => [...document.querySelectorAll('input[type=file]')].every(e => !e.value));
        assert.ok((await page.locator('.viewer-start-error').allTextContents()).every(text => text === ''));
        assert.equal(await resume(), current);
        await page.evaluate(() => window.releaseCleanup());
        await page.waitForFunction(() => window.cleanupFinished);
        assert.ok((await page.locator('.viewer-start-error').allTextContents()).every(text => text === ''));
        assert.equal(await resume(), current);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale}: immediate quiet cancellation, focus/filters/scroll, same-package retry during cleanup, late media safety and local ZIP cancellation`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
