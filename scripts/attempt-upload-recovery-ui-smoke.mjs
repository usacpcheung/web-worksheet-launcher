// Exercise real UI -> SharedAuthGate -> API client with isolated HTTP fixtures.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) {
    const context = await browser.newContext({ viewport: { width: locale === 'en' ? 1280 : 390, height: 900 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let mode = 'conflict', posts = [], deletes = 0, lookups = 0;
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const req = route.request();
        const url = new URL(req.url());
        const reply = (status, data) => route.fulfill({ status, json: data });
        if (url.pathname.endsWith('/session') && mode === 'probe-failure') return reply(503, { ok: false, error: { code: 'UPSTREAM_FAILED', message: 'Probe unavailable' } });
        if (url.pathname.endsWith('/session')) return reply(200, { ok: true, data: { ready: true, user: { sub: 'fixture' } } });
        if (url.pathname.includes('/upload-operations/')) {
          lookups++;
          return reply(200, { ok: true, data: { operationId: url.pathname.split('/').pop(), state: 'unknown' } });
        }
        if (req.method() === 'DELETE') { deletes++; return reply(200, { ok: true, data: {} }); }
        if (req.method() === 'POST' && url.pathname.endsWith('/attempts/upload')) {
          const action = url.searchParams.get('conflictAction');
          posts.push(action);
          if (mode === 'auth') return reply(401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Expired session' } });
          if (mode === 'network') return route.abort('failed');
          if (mode === 'invalid') return reply(400, { ok: false, error: { code: 'INVALID_ATTEMPT_PACKAGE', message: 'Invalid fixture' } });
          if ((mode === 'slot' && deletes === 0) || (mode === 'copy-slot' && action === 'copy' && deletes === 0)) return reply(409, { ok: false, error: { code: 'ATTEMPT_SLOT_LIMIT_REACHED', details: { slotLimit: 3 } } });
          if ((mode === 'conflict' || mode === 'copy-slot') && action === 'fail_on_conflict') return reply(409, { ok: false, error: { code: 'ATTEMPT_NAME_CONFLICT', details: { existingAttempt: { title: 'Fixture', status: 'in_progress' } } } });
          return reply(201, { ok: true, data: { uploaded_attempt_id: '11111111-1111-4111-8111-111111111111' } });
        }
        return reply(200, { ok: true, data: { items: [{ uploaded_attempt_id: '11111111-1111-4111-8111-111111111111', title: 'QA fixture', status: 'in_progress' }], attemptSlotLimit: 3 } });
      });
      await page.goto(`${base}/server/viewer/`);
      await page.evaluate(async () => {
        const { viewerStorage } = await import('/server/viewer/storage/index.js');
        const now = new Date().toISOString();
        await viewerStorage.attempts.put({ localId: 'conflict-ui', localAttemptId: 'conflict-ui', status: 'in_progress', startedAt: now,
          viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', title: 'QA fixture', blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Question' }, responseConfig: { inputType: 'text' } }] },
          answers: { q1: { value: 'Preserve answer' } }, metadata: { localId: 'conflict-ui', origin: 'local_source', updatedAt: now } });
      });
      await page.goto(`${base}/server/viewer/?localAttemptId=conflict-ui`);
      await page.waitForFunction(() => window.viewerSession?.state.serverSession.status === 'logged_in');
      const labels = await page.evaluate(async () => {
        const { t } = await import('/server/app/i18n/index.js');
        const { createServerApiClient } = await import('/server/app/api/server-api-client.js');
        window.viewerSession.apiClient = createServerApiClient({ operationLookupTimeoutMs: 100 });
        return Object.fromEntries(['viewer.upload.saveAttemptAriaLabel', 'common.actions.cancel', 'common.actions.saveAsCopy', 'common.actions.delete', 'viewer.attemptConflict.replaceServerAttempt', 'viewer.notifications.uploadAttempt.signInRequired', 'viewer.notifications.uploadAttempt.saved', 'viewer.notifications.uploadAttempt.invalidPackage', 'viewer.notifications.uploadAttempt.networkFailure'].map(key => [key, t(key)]));
      });
      assert.match(labels['viewer.notifications.uploadAttempt.networkFailure'], locale === 'en' ? /server may already have saved/ : /伺服器可能已儲存/);
      const save = page.getByRole('button', { name: labels['viewer.upload.saveAttemptAriaLabel'], exact: true });
      const dialog = () => page.getByRole('dialog');
      const noFalseAuth = async () => assert.equal(await page.evaluate(text => window.viewerSession.state.notifications.some(n => n.text === text), labels['viewer.notifications.uploadAttempt.signInRequired']), false);
      for (const action of ['cancel', 'replace', 'copy']) {
        posts = []; mode = 'conflict';
        await save.click();
        await dialog().waitFor({ timeout: 5000 });
        await noFalseAuth();
        const key = action === 'replace' ? 'viewer.attemptConflict.replaceServerAttempt' : action === 'copy' ? 'common.actions.saveAsCopy' : 'common.actions.cancel';
        await dialog().getByRole('button', { name: labels[key], exact: true }).click();
        await page.waitForFunction(() => !window.viewerSession.state.isUploadingAttemptPackage);
        assert.deepEqual(posts, action === 'cancel' ? ['fail_on_conflict'] : ['fail_on_conflict', action]);
      }
      mode = 'slot'; posts = []; deletes = 0;
      await save.click();
      await page.locator('.viewer-attempts-modal').waitFor();
      await page.locator('.viewer-attempts-modal').getByRole('button', { name: labels['common.actions.cancel'], exact: true }).click();
      assert.deepEqual(posts, ['fail_on_conflict']);
      assert.equal(deletes, 0);
      await noFalseAuth();
      for (const scenario of ['slot', 'copy-slot']) {
        mode = scenario; posts = []; deletes = 0;
        await save.click();
        await dialog().waitFor();
        if (scenario === 'copy-slot') {
          await dialog().getByRole('button', { name: labels['common.actions.saveAsCopy'], exact: true }).click();
        }
        await page.locator('.viewer-attempts-modal').waitFor();
        await noFalseAuth();
        await page.locator('.viewer-attempts-modal').getByRole('button', { name: labels['common.actions.delete'], exact: true }).click();
        await dialog().last().getByRole('button', { name: labels['common.actions.delete'], exact: true }).click();
        await page.waitForFunction(text => window.viewerSession.state.serverActionMessage === text && !window.viewerSession.state.isUploadingAttemptPackage, labels['viewer.notifications.uploadAttempt.saved']);
        assert.equal(deletes, 1);
        assert.deepEqual(posts, scenario === 'slot' ? ['fail_on_conflict', 'fail_on_conflict'] : ['fail_on_conflict', 'copy', 'copy']);
      }
      for (const scenario of ['invalid', 'network']) {
        mode = scenario; posts = []; lookups = 0;
        await save.click();
        const message = labels[scenario === 'invalid' ? 'viewer.notifications.uploadAttempt.invalidPackage' : 'viewer.notifications.uploadAttempt.networkFailure'];
        await page.waitForFunction(text => window.viewerSession.state.serverActionMessage === text && !window.viewerSession.state.isUploadingAttemptPackage, message);
        await noFalseAuth();
        assert.equal(await dialog().count(), 0);
        assert.equal(posts.length, 1);
        if (scenario === 'network') assert.ok(lookups > 0);
      }
      // Keep the real auth gate, observing only the navigation boundary.
      await page.evaluate(() => {
        window.authRedirects = [];
        window.viewerSession.authGate.options.redirectToAuth = value => window.authRedirects.push(value.redirectTo);
      });
      mode = 'probe-failure'; posts = [];
      await save.click();
      await page.waitForFunction(async () => {
        const { t } = await import('/server/app/i18n/index.js');
        return window.viewerSession.state.notifications.some(n => n.text === t('viewer.notifications.auth.unableToVerifySignIn'));
      });
      assert.equal(posts.length, 0);
      assert.equal(await page.evaluate(() => window.authRedirects.length), 0);
      mode = 'auth'; posts = [];
      await page.evaluate(() => window.viewerSession.refreshServerSession());
      await save.click();
      await page.waitForFunction(() => window.authRedirects.length === 1);
      assert.equal(posts.length, 1);
      assert.equal(await dialog().count(), 0);
      assert.equal(await page.evaluate(() => window.viewerSession.state.answers.q1.value), 'Preserve answer');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log('PASS: attempt conflict cancel/copy/replace, slot deletion/retry, chained copy-slot retry, and non-auth upload errors in both locales');
} finally { await browser.close(); }
