import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) for (const kind of ['attempts', 'published']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
      let signed = false, reads = 0;
      await page.addInitScript(locale => { localStorage.setItem('worksheetLauncher.locale', locale); window.open = () => ({ closed: false, close() {this.closed=true;} }); }, locale);
      await page.route(url => url.pathname.startsWith('/api/'), route => {
        const session = new URL(route.request().url()).pathname.endsWith('/session');
        if (!session) reads++;
        return route.fulfill({ status: signed ? 200 : 401, json: signed ? { ok: true, data: session ? { ready: true, user: { sub: 'qa' } } : { items: [] } } : { ok: false, error: { code: 'AUTH_REQUIRED', status: 401 } } });
      });
      await page.goto(`${base}/server/viewer/`);
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const openBrowser = async () => page.getByRole('button', { name: await label(kind === 'attempts' ? 'viewer.start.loginToManageServerAttempts' : 'viewer.start.loginToBrowsePublishedWorksheets'), exact: true }).click();
      const modal = page.locator(kind === 'attempts' ? '.viewer-attempts-modal' : '.viewer-published-browse-modal');
      const prompt = page.locator('.read-auth-prompt');
      await openBrowser(); await prompt.waitFor();
      assert.equal(await modal.count(), 0, 'browser must not flash behind consent');
      await prompt.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      await prompt.waitFor({ state: 'detached' });
      assert.equal(await modal.count(), 0); assert.equal(reads, 0);
      await openBrowser(); await prompt.waitFor(); signed = true;
      await prompt.getByRole('button', { name: await label('common.actions.signIn'), exact: true }).click();
      await modal.waitFor();
      await modal.getByText(await label(kind === 'attempts' ? 'viewer.serverAttempts.empty' : 'common.publishedBrowser.empty'), { exact: true }).waitFor();
      assert.equal(await modal.getByRole('button', { name: await label('common.actions.signIn'), exact: true }).count(), 0);
      signed = false;
      await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).click();
      const signIn = modal.getByRole('button', { name: await label('common.actions.signIn'), exact: true });
      await signIn.waitFor(); assert.equal(await prompt.count(), 0, 'expired refresh stays in the browser');
      assert.equal(await modal.getByText(await label(kind === 'attempts' ? 'viewer.serverAttempts.empty' : 'common.publishedBrowser.empty'), { exact: true }).count(), 0);
      signed = true; await signIn.click();
      await modal.getByText(await label(kind === 'attempts' ? 'viewer.serverAttempts.empty' : 'common.publishedBrowser.empty'), { exact: true }).waitFor();
      assert.equal(await prompt.count(), 0);
      assert.equal(await modal.evaluate(n => n.scrollWidth <= n.clientWidth), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${kind}/${locale}/${width}: gated entry, cancel, verified login, inline expiry and retry`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
