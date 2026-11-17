import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) for (const kind of ['drafts', 'published']) {
    const recovery = width === 390 ? 'same-tab' : 'popup';
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      let signedIn = false, serviceError = false, gate = null, probes = 0;
      const reads = [], writes = [], errors = [];
      const holdSession = () => {
        let release, started;
        const began = new Promise(resolve => { started = resolve; });
        gate = { started, wait: new Promise(resolve => { release = resolve; }) };
        return { began, release };
      };
      await context.addInitScript(({ locale, recovery }) => {
        localStorage.setItem('worksheetLauncher.locale', locale);
        window.popupCalls = 0;
        window.open = () => { window.popupCalls++; return recovery === 'popup' ? { closed: false } : null; };
      }, { locale, recovery });
      await context.route(url => url.pathname.startsWith('/api/'), async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') writes.push(request.method());
        if (path.endsWith('/session')) {
          probes++;
          const pending = gate; gate = null;
          if (pending) { pending.started(); await pending.wait; }
          return route.fulfill({ status: serviceError ? 503 : signedIn ? 200 : 401, json: serviceError
            ? { ok: false, error: { code: 'SERVICE_BUSY' } }
            : signedIn ? { ok: true, data: { ready: true, user: { sub: 'fixture' } } }
              : { ok: false, error: { code: 'AUTH_REQUIRED' } } });
        }
        reads.push(path);
        return route.fulfill({ json: { ok: true, data: { items: [{ uploaded_draft_id: 'qa-draft', published_package_id: 'qa-publication', title: 'QA manager row', owner_sub: 'fixture' }] } } });
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(async () => {
        const session = window.editorSession;
        session.updateTitle('Preserve this local worksheet');
        session.updateBlockContent(session.state.selectedBlockId, 'Preserve this reading text');
        await session.saveNow();
      });
      await page.waitForFunction(() => !window.editorSession.state.autosavePending);
      const snapshot = () => page.evaluate(() => ({ title: window.editorSession.state.draft.title,
        blocks: window.editorSession.state.draft.blocks, selected: window.editorSession.state.selectedBlockId }));
      const before = await snapshot();
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const entryKey = kind === 'drafts' ? 'editor.uploadedDraft.manage' : 'editor.published.browse';
      const open = async () => {
        await page.locator('.editor-more-actions').evaluate(node => node.open = true);
        await page.getByRole('button', { name: await label(entryKey), exact: true }).click();
      };
      const prompt = page.locator('.read-auth-prompt'), modal = page.locator('.browse-modal');
      const afterFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const entryReady = () => page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
      let held = holdSession(); const probeCount = probes;
      await open(); await held.began;
      assert.equal(await modal.count(), 0, 'no manager during entry preflight');
      assert.equal(await page.locator('[aria-busy="true"]').count(), 1);
      await page.locator('.action-column button').evaluateAll(buttons => buttons.filter(button => button.getAttribute('aria-busy') !== null).forEach(button => {
        if (!button.disabled) throw new Error('Both manager entries must be disabled during preflight');
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }));
      assert.equal(probes, probeCount + 1, 'repeated entries share one owner');
      held.release(); await prompt.waitFor();
      assert.equal(await modal.count(), 0, 'login consent is the only modal');
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) {
        await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/entry-${kind}-${locale}-${width}.png` });
      }
      await prompt.getByRole('button', { name: await label('common.actions.cancel'), exact: true }).click();
      await prompt.waitFor({ state: 'detached' }); await entryReady(); await afterFrames();
      assert.equal(await modal.count(), 0, 'Cancel leaves no manager');
      assert.equal(reads.length, 0); assert.equal(await page.evaluate(() => window.popupCalls), 0);
      assert.deepEqual(await snapshot(), before);
      assert.equal(await page.evaluate(() => window.editorSession.state.notifications.some(item => item.source === 'session.read')), false);
      assert.equal(await page.evaluate(() => window.editorSession.state.serverActionMessage), null);
      assert.equal(await page.getByRole('button', { name: await label(entryKey), exact: true })
        .evaluate(button => button === document.activeElement), true, 'Cancel restores focus to the requested entry');

      // A real service failure is retryable and never opens a login prompt/manager.
      serviceError = true; await open(); await entryReady(); serviceError = false;
      assert.equal(await prompt.count(), 0); assert.equal(await modal.count(), 0); assert.equal(reads.length, 0);
      await open(); await prompt.waitFor();
      if (recovery === 'popup') signedIn = true;
      await prompt.getByRole('button', { name: await label('common.actions.signIn'), exact: true }).click();
      if (recovery === 'same-tab') {
        const sameTab = prompt.getByRole('button', { name: await label('readAuth.sameTab'), exact: true });
        await sameTab.waitFor(); assert.equal(await modal.count(), 0, 'blocked-popup options have no manager underneath');
        signedIn = true;
        await Promise.all([page.waitForNavigation(), sameTab.click()]);
        await page.waitForFunction(() => window.editorSession && !new URL(location.href).searchParams.has('readAuthReturn'));
      }
      await modal.getByText('QA manager row', { exact: true }).waitFor();
      assert.equal(await modal.count(), 1); assert.equal(await prompt.count(), 0);
      assert.deepEqual(await snapshot(), before);
      if (recovery === 'popup') assert.equal(reads.length, 1, 'verified entry performs one list read');
      const loadedReads = reads.length;
      const refreshed = page.waitForResponse(response => {
        const path = new URL(response.url()).pathname;
        return path.startsWith('/api/') && !path.endsWith('/session');
      });
      await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).click();
      await refreshed; await afterFrames();
      await modal.getByText('QA manager row', { exact: true }).waitFor();
      assert.equal(reads.length, loadedReads + 1);
      await modal.getByRole('button', { name: await label('common.actions.close'), exact: true }).click();

      // A replaced draft must invalidate a delayed opener, even when the server is ready.
      held = holdSession(); const readsBeforeReplacement = reads.length;
      await open(); await held.began;
      await page.evaluate(() => window.editorSession.startNewWorksheet());
      const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/session'));
      held.release(); await response; await entryReady(); await afterFrames();
      assert.equal(await modal.count(), 0); assert.equal(reads.length, readsBeforeReplacement);
      await open(); await modal.getByText('QA manager row', { exact: true }).waitFor();
      await modal.getByRole('button', { name: await label('common.actions.close'), exact: true }).click();
      assert.equal(await modal.count(), 0);
      assert.deepEqual(writes, []); assert.deepEqual(errors, []);
      console.log(`PASS ${kind}/${locale}/${width}/${recovery}: cancel, retry, login continuation, refresh and stale entry`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
