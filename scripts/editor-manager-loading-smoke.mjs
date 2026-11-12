import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) for (const published of [true, false]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let sessionGate = null, listGate = null, failList = false;
      const hold = session => {
        let release, started;
        const began = new Promise(resolve => { started = resolve; });
        const gate = { started, wait: new Promise(resolve => { release = resolve; }) };
        if (session) sessionGate = gate; else listGate = gate;
        return { began, release };
      };
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const session = new URL(route.request().url()).pathname.endsWith('/session');
        const gate = session ? sessionGate : listGate;
        if (gate) {
          if (session) sessionGate = null; else listGate = null;
          gate.started(); await gate.wait;
        }
        return route.fulfill({ status: !session && failList ? 503 : 200, json: !session && failList
          ? { ok: false, error: { code: 'SERVICE_BUSY' } }
          : { ok: true, data: session ? { ready: true, user: { sub: 'fixture' } } : { items: [] } } });
      });
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession?.state.serverSession?.status === 'ready');
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const modal = page.locator('.browse-modal');
      const open = async () => {
        await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
        await page.getByRole('button', { name: await label(published ? 'editor.published.browse' : 'editor.uploadedDraft.manage'), exact: true }).click();
      };
      const loading = () => label(published ? 'common.publishedBrowser.loading' : 'editor.uploadedDraft.loading');
      const empty = () => label(published ? 'common.publishedBrowser.empty' : 'editor.uploadedDraft.empty');
      const assertLoading = async () => {
        await modal.getByText(await loading(), { exact: true }).waitFor();
        assert.equal(await modal.getByText(await empty(), { exact: true }).count(), 0);
        const buttons = modal.locator('.confirm-modal__actions button');
        assert.equal(await buttons.first().isDisabled(), true, 'list actions disabled during session check and fetch');
        assert.equal(await modal.getByRole('button', { name: await label('common.actions.close'), exact: true }).isEnabled(), true);
      };
      let session = hold(true), list = hold(false);
      await open();
      await session.began; await assertLoading(); session.release();
      await list.began; await assertLoading(); list.release();
      await modal.getByText(await empty(), { exact: true }).waitFor();
      for (const failure of [true, false]) {
        failList = failure;
        session = hold(true); list = hold(false);
        await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).click();
        await session.began; await assertLoading(); session.release();
        await list.began; await assertLoading(); list.release();
        if (failure) await modal.locator(published ? '.control-error' : '[role="alert"]').waitFor();
        else await modal.getByText(await empty(), { exact: true }).waitFor();
      }
      // Closing during preflight must invalidate the request and never reopen the manager.
      session = hold(true);
      await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).click();
      await session.began; await assertLoading();
      await modal.getByRole('button', { name: await label('common.actions.close'), exact: true }).click();
      // Reopen while the old response is still pending: it must not keep the new manager busy.
      await open();
      await modal.getByText(await empty(), { exact: true }).waitFor();
      const completed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/session'));
      session.release(); await completed;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await modal.getByText(await empty(), { exact: true }).waitFor();
      assert.equal(await modal.count(), 1);
      assert.deepEqual(errors, []);
      console.log(`PASS editor/${published ? 'published' : 'drafts'}/${locale}/${width}: session/list loading, errors, retry, close and reopen`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
