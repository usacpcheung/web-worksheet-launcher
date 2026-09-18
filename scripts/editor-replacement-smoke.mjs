import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8892';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    for (const source of ['local', 'published', 'uploaded']) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
        await page.goto(`${base}/server/editor/index.html`);
        await page.waitForFunction(() => window.editorSession);
        const fixture = await page.evaluate(async locale => {
          const { t, setLocale } = await import('/server/app/i18n/index.js');
          setLocale(locale);
          const session = window.editorSession;
          clearTimeout(session.autosaveTimer);
          session.state.draft.title = 'Outgoing worksheet';
          session.state.draftRevision += 1;
          await session.autosave();
          window.outgoingId = session.state.draft.localId;
          const { createWorksheetPackageFromDraft } = await import('/server/editor/worksheet-package.js');
          const bytes = createWorksheetPackageFromDraft({ ...session.state.draft, title: 'Incoming worksheet' }).bytes;
          session.state.serverSession = { status: 'ready', user: { sub: 'fixture' } };
          session.ensureServerSessionReady = async () => ({ ok: true });
          session.apiClient.listPublishedPackages = async () => ({ ok: true, data: { items: [{ published_package_id: 'pkg1', title: 'Incoming worksheet' }] } });
          session.apiClient.listUploadedDrafts = async () => ({ ok: true, data: { items: [{ uploaded_draft_id: 'draft1', title: 'Incoming worksheet' }] } });
          window.fetches = 0;
          session.apiClient.fetchPublishedPackageArtifact = session.apiClient.fetchUploadedDraftArtifact = async () => {
            window.fetches += 1;
            return { ok: true, data: bytes };
          };
          const put = session.storage.drafts.put.bind(session.storage.drafts);
          session.storage.drafts.put = async value => {
            if (window.failSave) throw new Error('Synthetic storage failure');
            if (window.failIncoming && value.localId !== window.outgoingId) throw new Error('Synthetic incoming save failure');
            return put(value);
          };
          session.notifyStateChange();
          return { bytes: Array.from(bytes), labels: Object.fromEntries([
            'editor.actions.importPackage', 'editor.published.browse', 'editor.published.openInEditor',
            'editor.uploadedDraft.manage', 'common.actions.open', 'common.actions.cancel',
          ].map(key => [key, t(key)])) };
        }, locale);
        assert.match(await page.title(), /editor/i);
        assert.ok(await page.locator('.editor-shell').isVisible());
        const label = key => fixture.labels[key];
        if (source !== 'local') {
          await page.locator('details').filter({ has: page.getByText(label('editor.published.browse'), { exact: true }) }).locator('summary').click();
          await page.getByRole('button', { name: label(source === 'published' ? 'editor.published.browse' : 'editor.uploadedDraft.manage'), exact: true }).click();
        }
        const trigger = async () => {
          if (source === 'local') {
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', { name: label('editor.actions.importPackage'), exact: true }).click();
            await (await chooser).setFiles({ name: 'incoming.zip', mimeType: 'application/zip', buffer: Buffer.from(fixture.bytes) });
          } else {
            await page.getByRole('button', { name: label(source === 'published' ? 'editor.published.openInEditor' : 'common.actions.open'), exact: true }).click();
          }
        };
        await trigger();
        const dialog = page.locator('.confirm-modal').filter({ has: page.locator('.confirm-modal__warning') });
        await dialog.waitFor({ state: 'visible' });
        assert.ok(await dialog.getByRole('button', { name: label('common.actions.cancel'), exact: true }).evaluate(button => button === document.activeElement));
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        if (shots) await page.screenshot({ path: `${shots}/replacement-${source}-${locale}-${width}.png` });
        await dialog.getByRole('button', { name: label('common.actions.cancel'), exact: true }).click();
        assert.equal(await page.evaluate(() => window.editorSession.state.draft.localId === window.outgoingId), true);
        assert.equal(await page.evaluate(() => window.fetches), 0);
        // Make a real pending revision; reject persistence before replacement.
        await page.evaluate(() => {
          window.editorSession.state.draft.title = 'Pending edit';
          window.editorSession.state.draftRevision += 1;
          window.failSave = true;
        });
        await trigger();
        await dialog.locator('button').last().click();
        await page.waitForFunction(() => window.editorSession.state.notifications.some(item => item.text?.includes('Synthetic storage failure')));
        assert.equal(await page.evaluate(() => window.editorSession.state.draft.title), 'Pending edit');
        assert.equal(await page.evaluate(() => window.editorSession.state.draft.localId === window.outgoingId), true);
        await page.evaluate(() => { window.failSave = false; });
        // The outgoing save succeeds, but the new draft cannot be persisted.
        await page.evaluate(() => { window.failIncoming = true; });
        if (source === 'published') await page.locator('.browse-modal__search-btn').click();
        await trigger();
        await dialog.locator('button').last().click();
        await page.waitForFunction(() => window.editorSession.state.notifications.some(item => item.text?.includes('Synthetic incoming save failure')));
        assert.equal(await page.evaluate(() => window.editorSession.state.draft.localId === window.outgoingId), true);
        assert.equal(await page.evaluate(() => window.editorSession.state.draft.title), 'Pending edit');
        await page.evaluate(() => { window.failIncoming = false; });
        if (source === 'published') await page.locator('.browse-modal__search-btn').click();
        await trigger();
        await dialog.locator('button').last().click();
        await page.waitForFunction(() => window.editorSession.state.draft.title === 'Incoming worksheet');
        assert.equal(await page.evaluate(async () => (await window.editorSession.storage.drafts.get(window.outgoingId)).title), 'Pending edit');
        assert.deepEqual(errors, []);
        console.log(`PASS ${source} ${locale} ${width}: cancel, failed save, saved replacement, keyboard focus, layout`);
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }
