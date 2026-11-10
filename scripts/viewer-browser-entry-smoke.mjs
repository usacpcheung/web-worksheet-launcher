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
      let signed = false, reads = 0, heldList = null, moreAvailable = false, lastListUrl = null;
      await page.addInitScript(locale => { localStorage.setItem('worksheetLauncher.locale', locale); window.open = () => ({ closed: false, close() {this.closed=true;} }); }, locale);
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const session = new URL(route.request().url()).pathname.endsWith('/session');
        if (!session) {
          reads++; lastListUrl = new URL(route.request().url());
          if (heldList) { const gate = heldList; heldList = null; gate.started(); await gate.wait; }
        }
        return route.fulfill({ status: signed ? 200 : 401, json: signed ? { ok: true, data: session ? { ready: true, user: { sub: 'qa' } } : { items: [], hasMore: moreAvailable, nextOffset: 20 } } : { ok: false, error: { code: 'AUTH_REQUIRED', status: 401 } } });
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
      const holdList = () => {
        let release, started;
        const began = new Promise(resolve => { started = resolve; });
        heldList = { started, wait: new Promise(resolve => { release = resolve; }) };
        return { began, release };
      };
      const assertLoading = async () => {
        await modal.getByText(await label(kind === 'attempts' ? 'viewer.serverAttempts.loading' : 'common.publishedBrowser.loading'), { exact: true }).waitFor();
        assert.equal(await modal.getByRole('button', { name: await label('common.actions.signIn'), exact: true }).count(), 0, 'no false sign-in state while authenticated');
        assert.equal(await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).isDisabled(), true);
        assert.equal(await modal.getByRole('button', { name: await label('common.actions.close'), exact: true }).isEnabled(), true);
      };
      await openBrowser(); await prompt.waitFor(); signed = true;
      let gate = holdList();
      await prompt.getByRole('button', { name: await label('common.actions.signIn'), exact: true }).click();
      await gate.began;
      await assertLoading();
      gate.release();
      await modal.waitFor();
      await modal.getByText(await label(kind === 'attempts' ? 'viewer.serverAttempts.empty' : 'common.publishedBrowser.empty'), { exact: true }).waitFor();
      assert.equal(await modal.getByRole('button', { name: await label('common.actions.signIn'), exact: true }).count(), 0);
      gate = holdList();
      await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).click();
      await gate.began; await assertLoading(); gate.release();
      await modal.getByText(await label(kind === 'attempts' ? 'viewer.serverAttempts.empty' : 'common.publishedBrowser.empty'), { exact: true }).waitFor();
      signed = false;
      await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).click();
      const signIn = modal.getByRole('button', { name: await label('common.actions.signIn'), exact: true });
      await signIn.waitFor(); assert.equal(await prompt.count(), 0, 'expired refresh stays in the browser');
      assert.equal(await modal.getByText(await label(kind === 'attempts' ? 'viewer.serverAttempts.empty' : 'common.publishedBrowser.empty'), { exact: true }).count(), 0);
      signed = true; await signIn.click();
      await modal.getByText(await label(kind === 'attempts' ? 'viewer.serverAttempts.empty' : 'common.publishedBrowser.empty'), { exact: true }).waitFor();
      assert.equal(await prompt.count(), 0);
      if (kind === 'published') {
        moreAvailable = true;
        await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).click();
        const more = modal.getByRole('button', { name: await label('common.actions.loadMore'), exact: true });
        await more.waitFor();
        gate = holdList(); await more.click();
        await gate.began; await assertLoading();
        assert.equal(await more.isDisabled(), true);
        assert.equal(lastListUrl.searchParams.get('offset'), '20');
        moreAvailable = false; gate.release();
        await modal.getByText(await label('common.publishedBrowser.empty'), { exact: true }).waitFor();
      }
      assert.equal(await modal.evaluate(n => n.scrollWidth <= n.clientWidth), true);
      gate = holdList();
      await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).click();
      await gate.began; await assertLoading();
      await modal.getByRole('button', { name: await label('common.actions.close'), exact: true }).click();
      const completed = page.waitForResponse(response => !new URL(response.url()).pathname.endsWith('/session') && new URL(response.url()).pathname.startsWith('/api/'));
      gate.release(); await completed;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await modal.count(), 0, 'late list response must not reopen a closed manager');
      assert.deepEqual(errors, []);
      console.log(`PASS ${kind}/${locale}/${width}: gated entry, pending initial/refresh states, close during loading, login, expiry and retry`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
