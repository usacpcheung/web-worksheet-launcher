// Controlled streamed HTTP responses; real API client, editor dialogs and ZIP import.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createStoredZip } from '../server/editor/zip-utils.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const zip = Buffer.from(createStoredZip([
  { path: 'manifest.json', data: JSON.stringify({ format: 'worksheet-package', packageVersion: 1, assets: [] }) },
  { path: 'content/worksheet.json', data: JSON.stringify({ title: 'Progress fixture', blocks: [{ blockId: 'c1', kind: 'content', position: 0, content: 'Test content' }] }) },
  { path: 'padding.bin', data: new Uint8Array(65536) },
]));
let pending, pendingSession, mode = 'known', requests = 0;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
  if (path.endsWith('/session')) {
    if (mode === 'session-stalled') { pendingSession = res; return; }
    return json({ user: { sub: 'fixture' } });
  }
  if (path.endsWith('/published')) return json({ items: ['one', 'two'].map(id => ({ published_package_id: id, title: `Published ${id}` })) });
  if (path.endsWith('/drafts')) return json({ items: ['one', 'two'].map(id => ({ uploaded_draft_id: id, title: `Draft ${id}` })) });
  if (path.endsWith('/artifact')) {
    requests++;
    pending = {
      first() {
        res.setHeader('Content-Type', 'application/zip');
        if (mode === 'known') res.setHeader('Content-Length', zip.length);
        res.write(mode === 'invalid' ? Buffer.from('invalid zip') : zip.subarray(0, Math.floor(zip.length / 2)));
      },
      finish() { res.end(mode === 'invalid' ? undefined : zip.subarray(Math.floor(zip.length / 2))); },
    };
    return;
  }
  if (path.startsWith('/api/')) return json({ items: [] });
  if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
  try {
    const file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Outside root');
    const bytes = await readFile(file);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) for (const source of ['published', 'uploaded']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(`${base}/server/editor/index.html`);
      await page.waitForFunction(() => window.editorSession);
      const labels = await page.evaluate(async () => {
        const session = window.editorSession;
        await session.refreshServerSession();
        const { t } = await import('/server/app/i18n/index.js');
        return Object.fromEntries(['editor.published.browse', 'editor.uploadedDraft.manage', 'common.actions.close', 'editor.actions.importPackage'].map(key => [key, t(key)]));
      });
      assert.match(await page.title(), /editor/i);
      const openList = async () => {
        if (!(await page.locator('.editor-more-actions').evaluate(element => element.open))) await page.locator('.editor-more-actions > summary').click();
        await page.getByRole('button', { name: labels[source === 'published' ? 'editor.published.browse' : 'editor.uploadedDraft.manage'], exact: true }).click();
      };
      await openList();
      await page.locator(`[data-editor-package-load="${source}:one"]`).waitFor();
      const originalId = await page.evaluate(() => {
        window.editorSession.packageSessionTimeoutMs = 800;
        return window.editorSession.state.draft.localId;
      });
      mode = 'session-stalled';
      const beforeRequests = requests;
      await page.locator(`[data-editor-package-load="${source}:one"]`).click();
      await page.locator('.confirm-modal').filter({ has: page.locator('.confirm-modal__warning') }).locator('button').last().click();
      await page.waitForFunction(() => window.editorSession.packageLoad.current?.stage === 'checking');
      await page.waitForFunction(() => !window.editorSession.packageLoad.current);
      assert.equal(requests, beforeRequests);
      assert.equal(await page.evaluate(() => window.editorSession.state.draft.localId), originalId);
      assert.equal(await page.getByRole('button', { name: labels['editor.actions.importPackage'], exact: true }).isEnabled(), true);
      assert.match(await page.locator('body').innerText(), /Session check timed out|登入狀態檢查已逾時/);
      mode = 'known';
      await page.evaluate(() => window.editorSession.refreshServerSession());
      pendingSession?.end(JSON.stringify({ ok: false, error: { status: 401 } }));
      assert.equal(await page.evaluate(() => window.editorSession.state.serverSession.status), 'ready');
      if (source === 'published') await page.locator('.browse-modal__search-btn').click();
      for (const nextMode of ['stalled', 'invalid', 'unknown', 'known']) {
        mode = nextMode; pending = null;
        await page.evaluate(mode => { window.editorSession.packageDownloadIdleMs = mode === 'stalled' ? 800 : 60000; }, mode);
        if (source === 'published' && ['invalid', 'unknown'].includes(nextMode)) await page.locator('.browse-modal__search-btn').click();
        if (nextMode === 'known') await openList();
        const button = page.locator(`[data-editor-package-load="${source}:one"]`);
        await button.click();
        await page.locator('.confirm-modal').filter({ has: page.locator('.confirm-modal__warning') }).locator('button').last().click();
        await page.waitForFunction(() => window.editorSession.packageLoad.current?.stage === 'downloading');
        while (!pending) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(await button.isDisabled(), true);
        assert.equal(await page.locator(`[data-editor-package-load="${source}:two"]`).isDisabled(), true);
        const count = requests;
        await page.evaluate(async () => {
          await window.editorSession.reopenUploadedDraftAsLocalCopy('other');
          await window.editorSession.reopenPublishedPackageAsLocalCopy('other');
        });
        assert.equal(requests, count);
        // Retain DOM identity during byte updates: no dialog rebuild per chunk.
        await page.evaluate(() => {
          const tracker = window.editorSession.packageLoad;
          if (!window.progressDomChecks) {
            window.progressDomChecks = [];
            const update = tracker.update.bind(tracker);
            tracker.update = (token, stage, progress) => {
              const selector = '[data-editor-package-load][aria-busy="true"]';
              const before = document.querySelector(selector);
              update(token, stage, progress);
              if (stage === 'downloading' && progress) window.progressDomChecks.push(before === document.querySelector(selector));
            };
          }
        });
        pending.first();
        if (mode === 'stalled') {
          const originalId = await page.evaluate(() => window.editorSession.state.draft.localId);
          await page.waitForFunction(() => !window.editorSession.packageLoad.current);
          assert.equal(await page.evaluate(() => window.editorSession.state.draft.localId), originalId);
          assert.equal(await page.getByRole('button', { name: labels['editor.actions.importPackage'], exact: true }).isEnabled(), true);
          assert.match(await page.locator('body').innerText(), /Download stalled|下載已停頓/);
          continue;
        }
        if (mode === 'known') await page.waitForFunction(() => window.editorSession.packageLoad.current?.percent > 0);
        else await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.progressDomChecks.every(Boolean)), true);
        assert.equal((await button.textContent()).includes('%'), mode === 'known');
        if (mode === 'known' && shots) await page.screenshot({ path: `${shots}/editor-load-${source}-${locale}-${width}.png` });
        const bounds = await button.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.equal(await button.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        // Closing does not cancel the request; reopening must recover its status.
        if (mode === 'known') {
          await page.getByRole('button', { name: labels['common.actions.close'], exact: true }).click();
          await openList();
          assert.match(await button.textContent(), /%/);
          await page.evaluate(() => {
            const session = window.editorSession;
            const save = session.saveBeforeWorksheetReplacement.bind(session);
            let first = true;
            session.saveBeforeWorksheetReplacement = async () => {
              if (first) {
                first = false;
                await new Promise(resolve => { window.finishSave = resolve; });
              }
              return save();
            };
          });
        }
        pending.finish();
        if (mode === 'known') {
          await page.waitForFunction(() => window.editorSession.packageLoad.current?.stage === 'saving' && window.finishSave);
          assert.match(await button.textContent(), /Saving|儲存/);
          assert.equal(await button.evaluate(element => element.scrollWidth <= element.clientWidth), true);
          assert.equal(await button.isDisabled(), true);
          await page.evaluate(() => window.finishSave());
        }
        await page.waitForFunction(() => !window.editorSession.packageLoad.current);
        if (mode !== 'invalid') assert.equal(await page.evaluate(() => window.editorSession.state.draft.title), 'Progress fixture');
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${source} ${locale} ${width}: session timeout/retry, streamed percent, unknown size, invalid ZIP retry, shared lock, DOM stability, close/reopen`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
