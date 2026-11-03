// Real viewer controls with private, isolated server fixtures; no production data.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openViewerAttemptMenu, clickViewerSave } from './viewer-navigation-test-helpers.mjs';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage(), errors = [], posts = [];
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      let signedIn = false, artifact, serverName, rows = [], failArtifact = false;
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      const apiFixture = async route => {
        const request = route.request(), url = new URL(request.url());
        const reply = (status, data) => route.fulfill({ status, json: data });
        if (!signedIn) return reply(401, { ok: false, error: { code: 'AUTH_REQUIRED' } });
        if (url.pathname.endsWith('/session')) return reply(200, { ok: true, data: { ready: true, user: { sub: 'qa' } } });
        if (request.method() === 'POST') {
          posts.push({ title: url.searchParams.get('title'), bytes: request.postDataBuffer() });
          artifact = request.postDataBuffer(); serverName = url.searchParams.get('title');
          rows = [{ uploaded_attempt_id: 'saved', title: serverName, subject: '', status: 'in_progress' }];
          return reply(201, { ok: true, data: { uploaded_attempt_id: 'saved', title: serverName, subject: '' } });
        }
        if (url.pathname.endsWith('/artifact') && failArtifact) return reply(503, { ok: false, error: { code: 'NETWORK_ERROR' } });
        if (url.pathname.endsWith('/artifact')) return route.fulfill({ contentType: 'application/zip', body: artifact });
        return reply(200, { ok: true, data: { items: rows, attemptSlotLimit: 3 } });
      };
      await page.route(url => url.pathname.startsWith('/api/'), apiFixture);
      await page.goto(`${base}/server/viewer/`);
      await page.evaluate(async () => {
        const { viewerStorage } = await import('/server/viewer/storage/index.js');
        const now = new Date().toISOString();
        await viewerStorage.attempts.put({ localId: 'menu-test', localAttemptId: 'menu-test', status: 'in_progress', startedAt: now,
          viewerPayload: { worksheetId: 'worksheet', snapshotId: 'snapshot', snapshotVersion: 1, title: 'Drawing worksheet 畫畫工作紙', blocks: [{ blockId: 'q', kind: 'question', prompt: { text: 'Your answer 答案' }, responseConfig: { inputType: 'text' } }] },
          answers: { q: { value: 'Keep my answer 保留答案' } }, metadata: { localId: 'menu-test', origin: 'local_source', updatedAt: now } });
      });
      await page.goto(`${base}/server/viewer/?localAttemptId=menu-test`);
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const menuButton = page.locator('[aria-controls="viewer-attempt-menu"]');
      const menu = page.locator('.viewer-attempt-menu');
      const print = page.locator('[aria-describedby="viewer-print-hint"]');
      await print.waitFor();
      assert.equal(await print.getAttribute('aria-disabled'), 'true');
      // aria-disabled allows hover, focus and tap explanations without printing.
      await print.focus(); assert.equal(await page.locator('.viewer-print-hint').isVisible(), true);
      await print.evaluate(node => node.click()); assert.equal(await page.locator('.viewer-attempt-dialog').count(), 0);
      await openViewerAttemptMenu(page);
      assert.equal(await menu.locator('button').count(), 4);
      assert.equal(await menu.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), true);
      if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/attempt-menu-${locale}-${width}.png` }); }
      await page.keyboard.press('Escape');
      assert.equal(await menuButton.evaluate(node => node === document.activeElement), true);
      // Local export never starts login or asks for identity.
      await openViewerAttemptMenu(page);
      const downloaded = page.waitForEvent('download');
      await menu.locator('button').nth(2).click(); await downloaded;
      assert.equal(await page.locator('.read-auth-prompt, .viewer-attempt-dialog').count(), 0);
      assert.equal(posts.length, 0);
      // Both protected entry points offer Sign in / Cancel without auto-login.
      await clickViewerSave(page);
      const auth = page.locator('.read-auth-prompt'); await auth.waitFor();
      await auth.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      await page.waitForFunction(() => !viewerSession.state.isUploadAttemptFlowActive);
      await openViewerAttemptMenu(page); await menu.locator('button').nth(1).click();
      await auth.waitFor();
      await auth.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      await page.locator('.viewer-attempts-modal').getByRole('button', { name: await label('common.actions.close'), exact: true }).click();
      assert.equal(posts.length, 0);
      // Existing details retain editable student and school fields.
      await openViewerAttemptMenu(page); await menu.locator('button').nth(3).click();
      await page.locator('#viewer-print-school-name-input').waitFor();
      assert.ok(await page.locator('#viewer-print-school-name-input').inputValue());
      await page.getByRole('button', { name: await label('viewer.details.printSchoolNameCustom'), exact: true }).click();
      assert.equal(await page.locator('#viewer-print-school-name-input').isEditable(), true);
      await page.locator('#viewer-print-school-name-input').fill('QA School');
      await page.keyboard.press('Escape');
      signedIn = true; await page.evaluate(() => viewerSession.refreshServerSession());
      await openViewerAttemptMenu(page); await menu.locator('button').first().click();
      const dialog = page.locator('.viewer-attempt-dialog');
      await dialog.waitFor();
      assert.equal(await dialog.locator('input').getAttribute('readonly'), null);
      await dialog.locator('input').fill('陳同學');
      await dialog.locator('[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('.viewer-attempt-dialog input')?.value.includes(' — 陳同學'));
      assert.equal(await dialog.locator('input').inputValue(), 'Drawing worksheet 畫畫工作紙 — 陳同學');
      await dialog.locator('input').fill('😀'.repeat(81));
      assert.equal(await dialog.locator('[type="submit"]').isDisabled(), true);
      await dialog.locator('input').fill('  ');
      assert.equal(await dialog.locator('[type="submit"]').isDisabled(), true);
      serverName = '我的作答 '.repeat(10).trim();
      await dialog.locator('input').fill(serverName);
      if (shots) await page.screenshot({ path: `${shots}/attempt-name-${locale}-${width}.png` });
      await dialog.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      assert.equal(posts.length, 0);
      await page.waitForFunction(() => !viewerSession.state.isUploadAttemptFlowActive);
      await page.reload();
      await clickViewerSave(page);
      await page.waitForFunction(() => !viewerSession.state.isUploadAttemptFlowActive);
      assert.equal(posts.length, 1); assert.equal(posts[0].title, serverName);
      assert.equal(await page.evaluate(() => viewerSession.state.viewerPayload.title), 'Drawing worksheet 畫畫工作紙');
      await openViewerAttemptMenu(page); await menu.locator('button').first().click();
      await dialog.waitFor(); assert.equal(await dialog.locator('input').isEditable(), false);
      assert.equal(await dialog.locator('input').inputValue(), serverName);
      await dialog.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      // Resume through the active worksheet manager: old local attempt remains saved.
      await openViewerAttemptMenu(page); await menu.locator('button').nth(1).click();
      const manager = page.locator('.viewer-attempts-modal');
      await manager.locator('.uploaded-draft-row').waitFor();
      await manager.locator('summary').click();
      assert.ok((await manager.locator('.uploaded-draft-details-body').innerText()).includes(serverName));
      assert.equal(await manager.evaluate(node => node.scrollWidth <= node.clientWidth), true);
      failArtifact = true;
      const failedRead = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/artifact') && response.status() === 503);
      await manager.getByRole('button', { name: await label('common.actions.resume'), exact: true }).click();
      await failedRead;
      await page.waitForFunction(() => Object.keys(viewerSession.state.uploadedAttemptActionInFlightById).length === 0);
      assert.equal(await page.evaluate(() => viewerSession.state.localAttemptId), 'menu-test');
      assert.equal(await page.evaluate(() => viewerSession.state.answers.q.value), 'Keep my answer 保留答案');
      failArtifact = false;
      await manager.getByRole('button', { name: await label('common.actions.resume'), exact: true }).click();
      await page.waitForFunction(() => viewerSession.state.localAttemptId !== 'menu-test');
      assert.equal(await page.evaluate(() => viewerSession.state.studentName), '陳同學');
      assert.equal(await page.evaluate(() => viewerSession.state.savedAttemptName), serverName);
      assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get('localAttemptId')), await page.evaluate(() => viewerSession.state.localAttemptId));
      assert.equal(await page.evaluate(async () => (await (await import('/server/viewer/storage/index.js')).viewerStorage.attempts.get('menu-test')).answers.q.value), 'Keep my answer 保留答案');
      // Set up a submitted attempt without identity, then exercise the actual print prompt.
      await page.evaluate(async () => {
        viewerSession.state.studentName = ''; viewerSession.state.studentNameResolved = false;
        viewerSession.state.status = 'completed'; viewerSession.state.submittedAt = new Date().toISOString();
        await viewerSession.autosave();
      });
      await page.reload();
      const instrumentPrint = () => page.evaluate(() => {
        const original = window.open.bind(window);
        window.open = (...args) => { const popup = original(...args); popup.print = () => { popup.printed = true; }; popup.close = () => {}; return popup; };
      });
      await instrumentPrint();
      // As in the print regression fixture, release opener routing for document.write fonts.
      await page.unrouteAll({ behavior: 'wait' });
      await print.click(); await dialog.waitFor();
      assert.equal(await dialog.locator('input').inputValue(), '');
      const popupReady = page.waitForEvent('popup');
      await dialog.locator('[type="submit"]').click();
      const popup = await popupReady; await popup.waitForFunction(() => window.printed); await popup.close();
      assert.equal(await page.evaluate(() => viewerSession.state.studentNameResolved), true);
      await page.reload(); await instrumentPrint();
      const secondPrint = page.waitForEvent('popup');
      await print.click(); const second = await secondPrint;
      await second.waitForFunction(() => window.printed); await second.close();
      assert.equal(await dialog.count(), 0, 'explicit blank choice survives reload and does not prompt on print again');
      await page.route(url => url.pathname.startsWith('/api/'), apiFixture);
      await page.evaluate(() => viewerSession.refreshServerSession());
      await openViewerAttemptMenu(page); await menu.locator('button').first().click();
      await dialog.waitFor(); assert.equal(await dialog.locator('input').inputValue(), serverName);
      await dialog.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      assert.deepEqual(errors, []);
      console.log(`PASS attempt menu ${locale}/${width}: local export, login consent, details, naming, persistence and active resume`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
