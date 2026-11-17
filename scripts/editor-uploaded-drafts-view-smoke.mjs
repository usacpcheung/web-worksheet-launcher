// View lifecycle fixtures; existing manager/publication smokes cover real shell workflows.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(async () => {
        const { createUploadedDraftsView } = await import('/server/editor/uploaded-drafts-view.js');
        const { t } = await import('/server/app/i18n/index.js');
        const root = document.createElement('div'); root.id = 'view-fixture'; document.body.append(root);
        window.viewEvents = []; window.viewCurrent = true;
        window.viewModel = { open: true, loading: false, error: null, slotLimit: 3, serverReady: true, publishBusy: false, publishingIds: [], items: [
          { uploaded_draft_id: 'draft-a', title: '<b>Draft A</b>', subject: 'Subject', created_at: '2026-11-01T00:00:00Z', publish_state: 'draft_only' },
          { uploaded_draft_id: 'draft-b', title: 'Draft B', publish_state: 'current_version_published', published_package_id: 'published-b' },
          { uploaded_draft_id: 'draft-c', title: 'Draft C', publish_state: 'unpublished_changes', published_package_id: 'published-c' },
        ] };
        const event = (type, value) => window.viewEvents.push([type, value]);
        window.view = createUploadedDraftsView({ root, t, createVisualLoadStatus: () => document.createElement('p'),
          onOpen: item => event('open', item.uploaded_draft_id), onCopyLink: id => event('copy', id),
          onPublish: (item, button) => event('publish', `${item.uploaded_draft_id}:${button.tagName}`),
          onDelete: item => event('delete', item.uploaded_draft_id), onRefresh: () => event('refresh'), onClose: () => event('close'),
        });
        window.renderView = () => window.view.render(window.viewModel, () => window.viewCurrent);
        window.renderView();
      });
      const root = page.locator('#view-fixture');
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const row = index => root.locator('.uploaded-draft-row').nth(index);
      assert.equal(await root.locator('.uploaded-draft-row').count(), 3);
      assert.equal(await row(0).locator('strong').innerText(), '<b>Draft A</b>');
      assert.equal(await row(0).locator('strong b').count(), 0);
      assert.equal(await row(1).getByRole('button', { name: await label('common.actions.publish'), exact: true }).count(), 0);
      await row(0).getByRole('button', { name: await label('common.actions.open'), exact: true }).click();
      await row(1).getByRole('button', { name: await label('editor.published.copyViewerLink'), exact: true }).click();
      await row(0).getByRole('button', { name: await label('common.actions.publish'), exact: true }).click();
      await row(2).getByRole('button', { name: await label('common.actions.delete'), exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.viewEvents), [['open','draft-a'],['copy','published-b'],['publish','draft-a:BUTTON'],['delete','draft-c']]);
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) {
        await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/uploaded-${locale}-${width}.png` });
      }
      await page.evaluate(() => {
        window.oldButtons = [...document.querySelectorAll('#view-fixture button')];
        window.viewModel.loading = true; window.viewModel.publishBusy = true; window.viewModel.serverReady = false; window.renderView();
        window.oldButtons.forEach(button => button.click());
      });
      assert.equal((await page.evaluate(() => window.viewEvents)).length, 4, 'replaced controls are inert');
      assert.equal(await root.locator('.uploaded-draft-row').count(), 3, 'background refresh retains cached rows');
      assert.equal(await root.locator('.confirm-modal__description').isVisible(), false);
      assert.equal(await row(1).getByRole('button', { name: await label('editor.published.copyViewerLink'), exact: true }).isDisabled(), true);
      assert.equal(await row(0).getByRole('button', { name: await label('editor.uploadedDraft.publishing'), exact: true }).isDisabled(), true);
      await page.evaluate(() => { window.viewModel.items = []; window.renderView(); });
      await root.getByText(await label('editor.uploadedDraft.loading'), { exact: true }).waitFor();
      assert.equal(await root.getByText(await label('editor.uploadedDraft.empty'), { exact: true }).count(), 0);
      await page.evaluate(() => { window.viewModel.loading = false; window.viewModel.error = 'Fixture error'; window.renderView(); });
      await root.getByRole('alert').getByText('Fixture error').waitFor();
      await page.evaluate(() => { window.viewModel.error = null; window.renderView(); });
      await root.getByText(await label('editor.uploadedDraft.empty'), { exact: true }).waitFor();
      await page.evaluate(() => {
        const foreground = document.createElement('div'); foreground.role = 'dialog'; foreground.id = 'foreground-fixture';
        const button = document.createElement('button'); button.textContent = 'Foreground'; foreground.append(button); document.body.append(foreground); button.focus();
        window.renderView();
      });
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Foreground', 'background rendering preserves foreground focus');
      await page.evaluate(() => {
        document.querySelector('#foreground-fixture').remove();
        window.viewCurrent = false;
        document.querySelectorAll('#view-fixture button').forEach(button => button.click());
      });
      assert.equal((await page.evaluate(() => window.viewEvents)).length, 4, 'replaced draft guard blocks even mounted old controls');
      await page.evaluate(() => {
        window.viewCurrent = true; window.viewModel.open = false; window.renderView();
      });
      assert.equal(await root.locator('.confirm-modal').count(), 0);
      await page.evaluate(() => {
        window.viewModel.open = true; window.renderView();
        const buttons = [...document.querySelectorAll('#view-fixture button')];
        window.view.destroy(); buttons.forEach(button => button.click()); window.renderView();
      });
      assert.equal(await root.locator('.confirm-modal').count(), 0);
      assert.equal((await page.evaluate(() => window.viewEvents)).length, 4);
      assert.deepEqual(errors, []);
      console.log(`PASS uploaded view ${locale}/${width}: states, actions, literal text, focus and disposal`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
