import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      let signedIn = false, failList = false, reads = 0;
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), route => {
        if (new URL(route.request().url()).pathname.endsWith('/session')) {
          return route.fulfill({ status: signedIn ? 200 : 401, json: signedIn
            ? { ok: true, data: { ready: true, user: { sub: 'fixture' } } }
            : { ok: false, error: { code: 'AUTH_REQUIRED' } } });
        }
        reads++;
        return route.fulfill({ status: failList ? 503 : 200, json: failList
          ? { ok: false, error: { code: 'SERVICE_BUSY' } }
          : { ok: true, data: { items: [] } } });
      });
      await page.goto(`${process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765'}/server/roleplayscene/`);
      const modal = page.locator('#server-modal-overlay');
      const open = async id => {
        const button = page.locator(id);
        if (!await button.isVisible()) await page.locator('#toolbar-more-btn').click();
        await button.click();
      };
      for (const id of ['#server-browse-published-btn', '#server-manage-btn']) {
        await open(id);
        await page.waitForFunction(() => !document.querySelector('#server-signin-btn')?.hidden);
        await page.waitForTimeout(100);
        assert.equal(await modal.isVisible(), false, 'signed-out action does not open list');
      }
      assert.equal(reads, 0, 'no protected list request while signed out');
      for (const published of [true, false]) {
        signedIn = true; failList = false;
        await open(published ? '#server-browse-published-btn' : '#server-manage-btn');
        await modal.waitFor({ state: 'visible' });
        const refresh = modal.locator(published ? '.published-refresh-action' : '.uploaded-drafts-refresh-action');
        for (const failure of ['service', 'auth']) {
          signedIn = failure !== 'auth'; failList = failure === 'service';
          await refresh.click();
          await modal.locator('[role="alert"]').waitFor();
          assert.equal(await modal.locator('.server-slot-usage').count(), 0);
          signedIn = true; failList = false;
          await refresh.click();
          await modal.locator('[role="alert"]').waitFor({ state: 'detached' });
        }
        await page.locator('#server-modal-close').click();
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale}/${width}: signed-out managers, service/auth refresh errors, retry`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
