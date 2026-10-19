import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      let signedIn = false, failList = false, reads = 0, hold = null, heldSession = null;
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        if (hold) { const wait = hold; hold = null; await wait; }
        if (new URL(route.request().url()).pathname.endsWith('/session')) {
          if (heldSession) {
            const pending = heldSession; heldSession = null;
            pending.started();
            await pending.wait;
            if (pending.network) return route.abort('failed');
            return route.fulfill({status:503,json:{ok:false,error:{code:'SERVICE_BUSY'}}});
          }
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
        await page.waitForTimeout(150); // Allow responsive toolbar relayout after modal focus restoration.
        const button = page.locator(id);
        await page.waitForFunction(id => { const target = document.querySelector(id), more = document.querySelector('#toolbar-more-btn'); return Boolean(target?.getClientRects().length || more?.getClientRects().length); }, id);
        if (!await button.isVisible()) await page.locator('#toolbar-more-btn').click();
        await button.click();
      };
      for (const id of ['#server-browse-published-btn', '#server-manage-btn']) {
        await open(id);
        await page.locator('.read-auth-prompt').waitFor();
        await page.locator('.read-auth-prompt button').first().click();
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
        if (published) {
          for (const fail of [false, true]) {
            failList = fail;
            let release;
            hold = new Promise(resolve => { release = resolve; });
            const idleLabel = await refresh.textContent();
            await refresh.click();
            assert.equal(await refresh.isDisabled(), true);
            assert.notEqual(await refresh.textContent(), idleLabel);
            assert.equal(await modal.locator('.published-more-action').isDisabled(), true);
            for (const control of await modal.locator('.published-browser-filters input, .published-browser-filters button').all()) {
              assert.equal(await control.isDisabled(), true);
            }
            release();
            await page.waitForFunction(() => !document.querySelector('.published-refresh-action').disabled);
            assert.equal(await refresh.textContent(), idleLabel);
            if (fail) await modal.locator('[role="alert"]').waitFor();
          }
          failList = false;
          await refresh.click();
          await modal.locator('[role="alert"]').waitFor({state:'detached'});
        }
        for (const failure of ['service', 'auth']) {
          signedIn = failure !== 'auth'; failList = failure === 'service';
          await refresh.click();
          if (failure === 'auth') { await page.locator('.read-auth-prompt').waitFor(); await page.locator('.read-auth-prompt button').first().click(); }
          await modal.locator('[role="alert"]').waitFor();
          assert.equal(await modal.locator('.server-slot-usage').count(), 0);
          signedIn = true; failList = false;
          await refresh.click();
          await modal.locator('[role="alert"]').waitFor({ state: 'detached' });
        }
        for (const network of [false, true]) {
          let release, started;
          const began = new Promise(resolve => { started = resolve; });
          heldSession = {network, started, wait:new Promise(resolve => {release = resolve;})};
          await refresh.click();
          await began;
          await page.locator('#server-modal-close').click();
          // A newer successful manager must retain its session and feedback.
          await open(published ? '#server-manage-btn' : '#server-browse-published-btn');
          await modal.waitFor({state:'visible'});
          const before = await page.locator('#server-status').textContent();
          const messageBefore = await page.locator('.app-messages__text').textContent();
          const responseDone = page.waitForEvent(network ? 'requestfailed' : 'response', event => {
            const url = event.url();
            return new URL(url).pathname.endsWith('/session');
          });
          release(); await responseDone;
          await page.waitForTimeout(100);
          assert.equal(await page.locator('#server-status').textContent(), before);
          assert.equal(await page.locator('.app-messages__text').textContent(), messageBefore);
          await page.locator('#server-modal-close').click();
          await open(published ? '#server-browse-published-btn' : '#server-manage-btn');
          await modal.waitFor({state:'visible'});
        }
        await page.locator('#server-modal-close').click();
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale}/${width}: signed-out managers, service/auth refresh errors, retry`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
