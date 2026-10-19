import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch();
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
try {
  for (const area of ['editor', 'viewer', 'roleplayscene']) for (const locale of ['en', 'zh-Hant']) for (const recovery of ['popup', 'same-tab']) {
    const context = await browser.newContext({ viewport: { width: locale === 'en' ? 1280 : 390, height: 900 } });
    try {
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') console.log('BROWSER ERROR', m.text()); });
      let signedIn = false, reads = 0;
      await page.addInitScript(({ locale, recovery }) => {
        localStorage.setItem('worksheetLauncher.locale', locale);
        window.open = () => recovery === 'popup' ? ({ closed: false }) : null;
      }, { locale, recovery });
      await page.route(url => url.pathname.startsWith('/api/'), route => {
        const session = new URL(route.request().url()).pathname.endsWith('/session');
        if (!session) reads++;
        return route.fulfill({ status: signedIn ? 200 : 401, json: signedIn
          ? { ok: true, data: session ? { ready: true, user: { sub: 'qa' } } : { items: [] } }
          : { ok: false, error: { code: 'AUTH_REQUIRED' } } });
      });
      await page.goto(`${base}/server/${area}/`);
      const label = async key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const open = async () => {
        if (area === 'editor') await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
        if (area === 'roleplayscene') {
          if (!await page.locator('#server-browse-published-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
          await page.locator('#server-browse-published-btn').click();
        } else await page.getByRole('button', { name: await label(area === 'editor' ? 'editor.published.browse' : 'viewer.start.loginToBrowsePublishedWorksheets'), exact: true }).click();
      };
      await open().catch(async e => { console.log(await page.locator('body').innerText(), errors); throw e; });
      const prompt = page.locator('.read-auth-prompt');
      await prompt.waitFor();
      assert.equal(reads, 0);
      await prompt.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      await prompt.waitFor({ state: 'detached' });
      assert.equal(reads, 0);
      // New attempt, then normal verified sign-in resumes the requested list.
      if (area === 'editor') await page.getByRole('button', { name: await label('common.actions.close'), exact: true }).last().click();
      if (area === 'viewer') await page.getByRole('button', { name: await label('common.actions.close'), exact: true }).last().click();
      await open(); await prompt.waitFor();
      if (recovery === 'popup') signedIn = true;
      await prompt.getByRole('button', { name: await label('common.actions.signIn'), exact: true }).click();
      if (recovery === 'same-tab') {
        const sameTab = prompt.getByRole('button', { name: await label('readAuth.sameTab'), exact: true });
        await sameTab.waitFor(); signedIn = true;
        await Promise.all([page.waitForNavigation(), sameTab.click()]);
        await page.waitForFunction(() => !new URL(location.href).searchParams.has('readAuthReturn'));
      }
      await page.waitForFunction(() => !document.querySelector('.read-auth-prompt'));
      await page.waitForTimeout(1200);
      assert.ok(reads > 0, 'verified login resumes read');
      assert.deepEqual(errors, []);
      console.log(`PASS ${area}/${locale}/${recovery}: contextual cancel and verified read continuation`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
