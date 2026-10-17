import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const app of ['editor', 'viewer']) for (const locale of ['en', 'zh-Hant']) {
    const context = await browser.newContext({ viewport: { width: locale === 'en' ? 1280 : 390, height: 900 } });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let holdSession = false, releaseSession, probes = 0, posts = 0, mode = 'conflict', sessionMode = 'ready';
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/session')) {
          if (holdSession) { probes++; await new Promise(resolve => { releaseSession = resolve; }); }
          if (sessionMode === 'network') return route.fulfill({ status: 503, json: { ok: false, error: { code: 'NETWORK_ERROR', message: 'Old session failure' } } });
          if (sessionMode === 'logged_out') return route.fulfill({ status: 401, json: { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Old sign-in failure' } } });
          return route.fulfill({ json: { ok: true, data: { ready: true, user: { sub: 'fixture' } } } });
        }
        if (route.request().method() === 'POST') {
          posts++;
          if (mode === 'conflict') return route.fulfill({ status: 409, json: { ok: false, error: {
            code: app === 'editor' ? 'DRAFT_NAME_CONFLICT' : 'ATTEMPT_NAME_CONFLICT',
            details: { existingDraft: { title: 'Fixture' }, existingAttempt: { title: 'Fixture' } },
          } } });
          return route.fulfill({ json: { ok: true, data: { uploaded_draft_id: 'fixture', uploaded_attempt_id: 'fixture' } } });
        }
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
      await page.waitForFunction(app => ['ready','logged_in'].includes(window[`${app}Session`]?.state.serverSession.status), app);
      if (app === 'editor') await page.locator('details').filter({ has: page.locator('[data-upload-cancel="editor"]') }).locator('summary').click();
      const labels = await page.evaluate(async app => {
        const { t } = await import('/server/app/i18n/index.js');
        return [t(app === 'editor' ? 'editor.server.uploadDraft' : 'viewer.upload.saveAttemptAriaLabel'), t('common.actions.cancel')];
      }, app);
      const button = page.getByRole('button', { name: labels[0], exact: true });
      holdSession = true;
      await button.click();
      for (let i = 0; !releaseSession && i < 100; i++) await page.waitForTimeout(20);
      assert.ok(releaseSession, 'preflight must be held');
      assert.equal(await button.isDisabled(), true, 'busy before preflight settles');
      // Simulate another already-queued activation, even if the browser would
      // ordinarily suppress a click on a disabled button.
      await button.dispatchEvent('click');
      await page.waitForTimeout(100);
      assert.equal(probes, 1);
      assert.equal(posts, 0);
      holdSession = false; releaseSession();
      await page.getByRole('dialog').waitFor();
      assert.equal(await button.isDisabled(), true, 'busy through conflict choice');
      await button.dispatchEvent('click');
      assert.equal(posts, 1);
      await page.getByRole('dialog').getByRole('button', { name: labels[1], exact: true }).click();
      await page.waitForFunction(app => !window[`${app}Session`].state[app === 'editor' ? 'isUploadDraftFlowActive' : 'isUploadAttemptFlowActive'], app);
      assert.equal(await button.isEnabled(), true);
      mode = 'success';
      await button.click();
      await page.waitForFunction(app => !window[`${app}Session`].state[app === 'editor' ? 'isUploadDraftFlowActive' : 'isUploadAttemptFlowActive'], app);
      assert.equal(posts, 2, 'one fresh upload after cancellation');
      assert.equal(await button.isEnabled(), true);
      if (app === 'viewer') for (const replacement of ['same-id', 'different-id']) for (const response of ['ready', 'network', 'logged_out']) {
        holdSession = true; releaseSession = null;
        await button.click();
        for (let i = 0; !releaseSession && i < 100; i++) await page.waitForTimeout(20);
        assert.ok(releaseSession);
        const beforePosts = posts;
        await page.evaluate(async replacement => {
          const session = window.viewerSession;
          // Use the same state replacement entry point as resume/import, with
          // a complete in-memory fixture rather than a missing source package.
          const localId = replacement === 'different-id' ? `${session.state.localAttemptId}-next` : session.state.localAttemptId;
          const previousGeneration = session._uploadContextGeneration;
          session.applyAttemptState({ localId, localAttemptId: localId,
            viewerPayload: session.state.viewerPayload, answers: session.state.answers,
            status: session.state.status, startedAt: session.state.startedAt,
          });
          if (session._uploadContextGeneration === previousGeneration) throw new Error('Fixture failed to replace active attempt');
          session.state.serverActionMessage = 'Replacement owns this message';
        }, replacement);
        sessionMode = response; holdSession = false; releaseSession();
        await page.waitForFunction(() => !window.viewerSession.state.isUploadAttemptFlowActive);
        assert.equal(posts, beforePosts, `${replacement}: stale preflight must not upload`);
        assert.equal(await page.evaluate(() => window.viewerSession.state.serverActionMessage), 'Replacement owns this message');
        assert.equal(await button.isEnabled(), true);
        sessionMode = 'ready';
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log('PASS: single preflight/upload owner through queued clicks and conflict dialogs, then a fresh upload in both locales');
} finally { await browser.close(); }
