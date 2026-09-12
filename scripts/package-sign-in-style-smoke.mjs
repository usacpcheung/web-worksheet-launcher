// Run against scripts/static-server.mjs. No real authentication requests.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) for (const surface of ['viewer', 'roleplayscene']) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ status: 401, json: { ok: false, error: { code: 'AUTH_REQUIRED', requiresSignIn: true, message: 'Sign in required' } } }));
    await page.goto(`${base}/server/${surface}/index.html?${surface === 'viewer' ? 'publishedPackageId' : 'publishedSceneId'}=11111111-1111-4111-8111-111111111111`);
    const card = page.locator(surface === 'viewer' ? '.viewer-fatal-panel--recoverable-auth' : '.direct-launch--authentication-required .direct-launch__panel');
    await card.waitFor({ timeout: 10000 }).catch(async error => { console.log(await page.locator('body').innerText(), errors); throw error; });
    const primary = card.getByRole('button', { name: locale === 'en' ? 'Sign in and continue' : '登入並繼續', exact: true });
    await primary.waitFor();
    await page.waitForLoadState('networkidle');
    await primary.focus();
    assert.equal(await primary.evaluate(e => e === document.activeElement), true);
    assert.equal(await primary.evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(49, 91, 232)');
    assert.equal(await card.evaluate(e => getComputedStyle(e).borderLeftColor), 'rgb(37, 99, 235)');
    assert.equal(await card.evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && e.scrollWidth <= e.clientWidth; }), true);
    if (shots) await page.screenshot({ path: `${shots}/sign-in-${surface}-${locale}-${width}.png` });
    if (surface === 'viewer') {
      await card.locator('summary').click();
      assert.equal(await card.locator('pre').isVisible(), true);
    }
    // Secondary action retains its destination and leaves the gate.
    await card.getByRole('button').last().click();
    await card.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS: both sign-in cards, both languages, desktop/mobile, keyboard focus, details and return actions');
} finally { await browser.close(); }


