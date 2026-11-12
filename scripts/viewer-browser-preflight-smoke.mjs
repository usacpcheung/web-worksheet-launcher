// Hold the authentication probe itself: list-only delays cannot detect a silent entry gap.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openViewerAttemptMenu } from './viewer-navigation-test-helpers.mjs';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    for (const surface of ['active-attempts', 'start-attempts', 'start-published']) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const page = await context.newPage(), errors = [];
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
        let pendingSession, pendingList;
        const hold = (kind, status = 200) => {
          let started, release;
          const began = new Promise(resolve => { started = resolve; });
          const pending = { status, started, wait: new Promise(resolve => { release = resolve; }) };
          if (kind === 'session') pendingSession = pending; else pendingList = pending;
          return { began, release };
        };
        await page.route(url => url.pathname.startsWith('/api/'), async route => {
          const session = new URL(route.request().url()).pathname.endsWith('/session');
          const pending = session ? pendingSession : pendingList;
          if (session) pendingSession = null; else pendingList = null;
          if (pending) { pending.started(); await pending.wait; }
          const status = pending?.status || 200;
          await route.fulfill({ status, json: status === 200
            ? { ok: true, data: session ? { ready: true, user: { sub: 'qa' } } : { items: [] } }
            : { ok: false, error: { code: status === 401 ? 'AUTH_REQUIRED' : 'SERVICE_UNAVAILABLE', status } } });
        });
        await page.goto(`${base}/server/viewer/`);
        await page.waitForLoadState('networkidle');
        if (surface === 'active-attempts') {
          await page.evaluate(async () => {
            const { viewerStorage } = await import('/server/viewer/storage/index.js');
            const now = new Date().toISOString();
            await viewerStorage.attempts.put({ localId: 'preflight', localAttemptId: 'preflight', status: 'in_progress', startedAt: now,
              viewerPayload: { worksheetId: 'qa', snapshotId: 'qa', snapshotVersion: 1, title: 'QA worksheet', blocks: [{ blockId: 'q', kind: 'question', prompt: { text: 'Your answer' }, responseConfig: { inputType: 'text' } }] },
              answers: { q: { value: 'Preserved answer' } }, metadata: { localId: 'preflight', origin: 'local_source', updatedAt: now } });
          });
          await page.goto(`${base}/server/viewer/?localAttemptId=preflight`);
          await page.waitForLoadState('networkidle');
        }
        const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
        const published = surface === 'start-published';
        const modal = page.locator(published ? '.viewer-published-browse-modal' : '.viewer-attempts-modal');
        const prompt = page.locator('.read-auth-prompt');
        const checking = page.getByText(await label('viewer.packageLoad.checking'), { exact: true });
        const open = async () => {
          if (surface === 'active-attempts') {
            await openViewerAttemptMenu(page);
            await page.locator('.viewer-attempt-menu button').nth(1).click();
          } else {
            const signedOut = page.getByRole('button', { name: await label(published ? 'viewer.start.loginToBrowsePublishedWorksheets' : 'viewer.start.loginToManageServerAttempts'), exact: true });
            const signedIn = page.getByRole('button', { name: await label(published ? 'viewer.start.browsePublishedWorksheets' : 'viewer.start.manageServerAttempts'), exact: true });
            await signedOut.or(signedIn).click();
          }
        };
        for (const status of [401, 503, 200]) {
          const probe = hold('session', status);
          await open(); await probe.began;
          await checking.waitFor();
          assert.equal(await page.locator('.notification-toast[role="alert"]').count(), 0, 'retry clears the previous entry failure');
          assert.equal(await modal.count(), 0, 'no manager before authentication is resolved');
          assert.equal(await prompt.count(), 0, 'no false consent prompt during session check');
          assert.equal(await checking.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), true);
          if (status === 200 && process.env.VIEWER_SMOKE_SCREENSHOTS) {
            await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/preflight-${surface}-${locale}-${width}.png` });
          }
          const list = status === 200 ? hold('list') : null;
          probe.release();
          if (status === 401) {
            await prompt.waitFor(); await checking.waitFor({ state: 'detached' });
            await prompt.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
            await prompt.waitFor({ state: 'detached' });
            assert.equal(await modal.count(), 0);
          } else if (status === 503) {
            await checking.waitFor({ state: 'detached' });
            await page.locator('.notification-toast[role="alert"]').first().waitFor();
            assert.equal(await modal.count(), 0);
          } else {
            await list.began;
            await modal.getByText(await label(published ? 'common.publishedBrowser.loading' : 'viewer.serverAttempts.loading'), { exact: true }).waitFor();
            assert.equal(await checking.count(), 0);
            list.release();
            await modal.getByText(await label(published ? 'common.publishedBrowser.empty' : 'viewer.serverAttempts.empty'), { exact: true }).waitFor();
            await modal.getByRole('button', { name: await label('common.actions.close'), exact: true }).click();
          }
        }
        if (surface === 'active-attempts') {
          const probe = hold('session');
          await open(); await probe.began; await checking.waitFor();
          // Replacing the active attempt invalidates its pending manager entry.
          await page.evaluate(() => { viewerSession._uploadContextGeneration++; });
          await checking.waitFor({ state: 'detached' });
          const completed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/session'));
          probe.release(); await completed;
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.equal(await modal.count(), 0, 'late probe cannot open a stale manager');
          assert.equal(await page.locator('textarea').first().inputValue(), 'Preserved answer');
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${surface}/${locale}/${width}: immediate probe feedback, consent/cancel, failure/retry, list handoff and stale response`);
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }
