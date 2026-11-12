import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const [width, height] of [[390, 844], [900, 900], [1280, 600]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = []; let popups = 0;
      page.on('pageerror', error => errors.push(error.message));
      page.on('popup', () => popups++);
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ status: 401, json: { ok: false, error: { code: 'AUTH_REQUIRED' } } }));
      await page.goto(`${base}/server/viewer/`);
      await page.evaluate(async () => {
        const { viewerStorage } = await import('/server/viewer/storage/index.js');
        const now = new Date().toISOString();
        const blocks = Array.from({ length: 6 }, (_, i) => ({ blockId: `q${i}`, position: i, kind: 'question', prompt: { text: `Question ${i + 1}` }, responseConfig: { inputType: 'text' } }));
        await viewerStorage.attempts.put({ localId: 'drawer-print', localAttemptId: 'drawer-print', status: 'in_progress', startedAt: now,
          viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', snapshotVersion: 1, title: 'Print fixture 列印測試', blocks },
          answers: Object.fromEntries(blocks.map(block => [block.blockId, { value: 'Test answer 答案' }])),
          metadata: { localId: 'drawer-print', origin: 'local_source', updatedAt: now } });
      });
      await page.goto(`${base}/server/viewer/?localAttemptId=drawer-print`);
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const drawer = page.locator('.viewer-actions-drawer');
      const launcher = page.locator('.viewer-actions-launcher');
      const print = drawer.locator('.viewer-drawer-print button');
      const headerPrint = page.locator('[aria-describedby="viewer-print-hint"]');
      const hint = drawer.locator('#viewer-drawer-print-hint');
      const identity = page.locator('.viewer-attempt-dialog');
      await launcher.click();
      await print.waitFor();
      assert.equal(await print.textContent(), await label('viewer.print.printReportTitle'));
      assert.equal(await print.getAttribute('aria-disabled'), 'true');
      await print.focus(); await hint.waitFor({ state: 'visible' });
      await print.press('Enter');
      assert.equal(await drawer.evaluate(node => node.open), true, 'unavailable Print must keep its explanation in the drawer');
      assert.equal(await identity.count(), 0); assert.equal(popups, 0);
      assert.equal(await page.evaluate(() => viewerSession.state.status), 'in_progress');
      if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/print-before-${locale}-${width}x${height}.png` }); }
      await drawer.getByRole('button', { name: await label('viewer.actions.submit'), exact: true }).click();
      await page.waitForFunction(() => viewerSession.state.status === 'completed' && !viewerSession.state.isFinalizing);
      assert.equal(await drawer.evaluate(node => node.open), false);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await launcher.click();
      assert.equal(await print.getAttribute('aria-disabled'), 'false');
      assert.equal(await hint.isVisible(), false);
      await print.scrollIntoViewIfNeeded();
      assert.equal(await print.evaluate(node => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }), true);
      if (shots) await page.screenshot({ path: `${shots}/print-after-${locale}-${width}x${height}.png` });
      // Cancel the existing optional name prompt, then return through the same drawer action.
      await print.click(); await identity.waitFor();
      assert.equal(await drawer.evaluate(node => node.open), false);
      assert.equal(await identity.evaluate(node => node.contains(document.activeElement)), true);
      await identity.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      assert.equal(await launcher.evaluate(node => document.activeElement === node), true);
      assert.equal(popups, 0);
      const instrument = () => page.evaluate(() => {
        const original = window.open.bind(window);
        window.open = (...args) => { const popup = original(...args); popup.print = () => { popup.printed = true; }; popup.close = () => {}; return popup; };
      });
      await instrument();
      // Let document.write's print resources finish without opener route interception.
      await page.unrouteAll({ behavior: 'wait' });
      await launcher.click(); await print.press('Enter'); await identity.waitFor();
      assert.equal(await identity.locator('input').inputValue(), '');
      const opened = page.waitForEvent('popup');
      await identity.locator('[type="submit"]').click();
      const popup = await opened; await popup.waitForFunction(() => window.printed); await popup.close();
      assert.equal(popups, 1);
      assert.equal(await page.evaluate(() => viewerSession.state.studentNameResolved), true);
      // Persisted completion/intentional empty name retain the action without prompting again.
      await page.reload(); await instrument();
      await launcher.click();
      assert.equal(await print.getAttribute('aria-disabled'), 'false');
      const reopened = page.waitForEvent('popup'); await print.click();
      const next = await reopened; await next.waitForFunction(() => window.printed); await next.close();
      assert.equal(await identity.count(), 0); assert.equal(popups, 2);
      // Resizing must neither duplicate the desktop action nor leave a modal open.
      await launcher.click();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForFunction(() => !document.querySelector('.viewer-actions-drawer').open);
      assert.equal(await page.locator('.viewer-drawer-print').isVisible(), false);
      assert.equal(await headerPrint.isVisible(), true);
      assert.equal(await headerPrint.evaluate(node => Boolean(node.closest('.viewer-action-panel'))), true);
      await page.setViewportSize({ width, height });
      await launcher.click(); await print.waitFor();
      assert.equal(await print.getAttribute('aria-disabled'), 'false');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
      console.log(`PASS drawer Print ${locale}/${width}x${height}: unavailable hint, submit, cancel, blank-name print, reload and resize`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
