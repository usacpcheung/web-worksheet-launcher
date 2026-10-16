import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({
        status: 401, json: { ok: false, error: { code: 'AUTH_REQUIRED' } },
      }));
      await page.goto(`${base}/server/viewer/`);
      const labels = await page.evaluate(async () => {
        const { ViewerAttemptSession } = await import('/server/viewer/main.js');
        const { t } = await import('/server/app/i18n/index.js');
        const begin = ViewerAttemptSession.prototype.beginServerSignIn;
        // Capture the real start-panel instance without replacing its auth flow.
        ViewerAttemptSession.prototype.beginServerSignIn = function (...args) {
          window.qaSession = this;
          this.apiClient.getSession = () => new Promise(resolve => { window.releaseProbe = resolve; });
          return begin.apply(this, args);
        };
        window.open = () => ({ closed: false, close() { this.closed = true; } });
        return Object.fromEntries([
          'viewer.start.loginToManageServerAttempts', 'viewer.start.manageServerAttempts',
          'viewer.start.browsePublishedWorksheets', 'common.actions.signIn',
          'common.actions.signingIn', 'common.actions.refresh', 'common.actions.close',
          'apiErrors.popupPending', 'apiErrors.popupBlocked', 'apiErrors.network',
        ].map(key => [key, t(key)]));
      });
      const click = (scope, key) => scope.getByRole('button', { name: labels[key], exact: true }).click();
      async function checkFeedback(scope, key) {
        const region = scope.locator('.viewer-auth-feedback:not([hidden])');
        await region.waitFor({ state: 'visible' });
        assert.equal(await region.textContent(), labels[key]);
        assert.equal(await region.getAttribute('role'), 'status');
        assert.equal(await page.locator('.viewer-auth-feedback:not([hidden])').count(), 1);
        const box = await region.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'feedback must fit viewport');
      }
      const start = page.locator('.viewer-start-panel');
      await click(start, 'viewer.start.loginToManageServerAttempts');
      await checkFeedback(start, 'apiErrors.popupPending');
      await page.evaluate(() => window.qaSession._authPopupFlow.cancel());
      assert.equal(await page.locator('.viewer-auth-feedback:not([hidden])').count(), 0);

      for (const surface of ['attempts', 'published']) {
        await page.evaluate(async () => {
          const session = window.qaSession;
          session.apiClient.getSession = async () => ({ ok: true, data: { ready: true, user: { sub: 'fixture' } } });
          session.apiClient.listUploadedAttempts = session.apiClient.listPublishedPackages = async () => ({ ok: true, data: { items: [] } });
          await session.probeServerSessionSilently({ force: true });
        });
        await click(start, surface === 'attempts' ? 'viewer.start.manageServerAttempts' : 'viewer.start.browsePublishedWorksheets');
        const modal = page.locator(surface === 'attempts' ? '.viewer-attempts-modal' : '.viewer-published-browse-modal');
        await modal.waitFor({ state: 'visible' });
        // A real session probe models expiry; Refresh renders the new modal state.
        await page.evaluate(async () => {
          const session = window.qaSession;
          session.apiClient.getSession = async () => ({ ok: false, error: { code: 'AUTH_REQUIRED', status: 401 } });
          await session.probeServerSessionSilently({ force: true });
        });
        await click(modal, 'common.actions.refresh');
        await click(modal, 'common.actions.signIn');
        await checkFeedback(modal, 'apiErrors.popupPending');
        if (surface === 'attempts') assert.equal(await modal.getByRole('button', { name: labels['common.actions.signingIn'], exact: true }).isDisabled(), true);
        await page.evaluate(() => window.qaSession._authPopupFlow.cancel());
        assert.equal(await page.locator('.viewer-auth-feedback:not([hidden])').count(), 0);
        await page.evaluate(() => { window.open = () => null; });
        await click(modal, 'common.actions.signIn');
        await checkFeedback(modal, 'apiErrors.popupBlocked');
        await click(modal, 'common.actions.close');
        await checkFeedback(start, 'apiErrors.popupBlocked');
        await page.evaluate(() => { window.open = () => ({ closed: false, close() { this.closed = true; } }); });
      }
      // Default callback path: success clears progress; failure remains localized.
      for (const ok of [true, false]) {
        await page.evaluate(ok => {
          const session = window.qaSession;
          session.beginServerSignIn();
          window.qaCompletion = session._authPopupFlow.promise;
          session.apiClient.getSession = async () => ok
            ? { ok: true, data: { ready: true, user: { sub: 'fixture' } } }
            : { ok: false, error: { code: 'NETWORK_ERROR' } };
          const event = new Event('message');
          Object.assign(event, { origin: location.origin, source: session._authPopupWindow,
            data: { type: 'worksheet-launcher-auth-complete', authFlowId: session._activeAuthFlowId } });
          window.dispatchEvent(event);
        }, ok);
        await page.evaluate(() => window.qaCompletion);
        if (ok) assert.equal(await page.locator('.viewer-auth-feedback:not([hidden])').count(), 0);
        else await checkFeedback(start, 'apiErrors.network');
      }
      console.log(`PASS viewer start/attempts/published visible feedback, cancellation, blocked, success/failure: ${locale}/${width}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
