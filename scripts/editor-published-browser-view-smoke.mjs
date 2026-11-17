// Presentation boundary fixtures; existing manager/load/auth suites exercise the shell.
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
        const { createPublishedBrowserView } = await import('/server/editor/published-browser-view.js');
        const { formatUploadedDraftTimestamp } = await import('/server/editor/uploaded-drafts-view.js');
        const { t } = await import('/server/app/i18n/index.js');
        const root = document.createElement('div'); root.id = 'view-fixture'; document.body.append(root);
        window.viewEvents = []; window.viewCurrent = true;
        window.viewModel = { open: true, title: 'Initial title', subject: '', owner: '', loading: false, error: null, hasMore: true,
          currentUserSub: 'fixture', openingIds: [], items: [
            { published_package_id: 'published-a', title: '<b>Package A</b>', subject: 'Subject', owner_sub: 'fixture', owner_email: 'fixture@example.test', published_at: '2026-11-01T00:00:00Z' },
            { published_package_id: 'published-b', title: 'Package B', owner_sub: 'other', owner_name: 'Other author' },
          ] };
        const event = (type, value) => window.viewEvents.push([type, value]);
        window.view = createPublishedBrowserView({ root, t, formatTimestamp: formatUploadedDraftTimestamp,
          createVisualLoadStatus: () => document.createElement('p'),
          onOpen: item => event('open', item.published_package_id), onCopyLink: item => event('copy', item.published_package_id),
          onDelete: item => event('delete', item.published_package_id), onSearch: filters => event('search', filters),
          onRefresh: filters => event('refresh', filters), onLoadMore: () => event('more'), onClose: () => event('close'),
        });
        window.renderView = () => window.view.render(window.viewModel, () => window.viewCurrent);
        window.renderView();
      });
      const root = page.locator('#view-fixture');
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const button = async key => root.getByRole('button', { name: await label(key), exact: true });
      const row = index => root.locator('.published-result-row').nth(index);
      assert.equal(await row(0).locator('strong').innerText(), '<b>Package A</b>');
      assert.equal(await root.locator('strong b').count(), 0);
      assert.equal(await row(1).locator('.uploaded-draft-action--danger').count(), 0, 'only owner sees Delete');
      await row(0).getByRole('button', { name: await label('editor.published.openInEditor'), exact: true }).click();
      await row(1).getByRole('button', { name: await label('editor.published.copyViewerLink'), exact: true }).click();
      await row(0).getByRole('button', { name: await label('common.actions.delete'), exact: true }).click();
      const inputs = root.locator('.browse-modal__filters input');
      assert.equal(await inputs.nth(0).inputValue(), 'Initial title');
      await inputs.nth(0).fill('New title'); await inputs.nth(1).fill('Math'); await inputs.nth(2).fill('author@example.test');
      await (await button('common.publishedBrowser.searchAriaLabel')).click();
      await inputs.nth(0).fill('Updated filter');
      await (await button('common.actions.refresh')).click();
      await (await button('common.actions.loadMore')).click();
      assert.deepEqual(await page.evaluate(() => window.viewEvents), [
        ['open','published-a'], ['copy','published-b'], ['delete','published-a'],
        ['search',{ title: 'New title', subject: 'Math', owner: 'author@example.test' }],
        ['refresh',{ title: 'Updated filter', subject: 'Math', owner: 'author@example.test' }], ['more',undefined],
      ], 'live filters are captured only by search/refresh; pagination supplies no replacement filters');
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) {
        await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/published-${locale}-${width}.png` });
      }
      await page.evaluate(() => {
        window.oldButtons = [...document.querySelectorAll('#view-fixture button')];
        window.viewModel.loading = true; window.renderView(); window.oldButtons.forEach(button => button.click());
      });
      assert.equal((await page.evaluate(() => window.viewEvents)).length, 6, 'replaced controls are inert');
      await root.getByText(await label('common.publishedBrowser.loading'), { exact: true }).waitFor();
      assert.equal(await root.locator('.published-result-row').count(), 0);
      assert.equal(await (await button('common.actions.loading')).isDisabled(), true);
      assert.equal(await (await button('common.actions.refresh')).isDisabled(), true);
      assert.equal(await (await button('common.publishedBrowser.searchAriaLabel')).isDisabled(), true);
      assert.equal(await (await button('common.actions.close')).isEnabled(), true);
      await page.evaluate(() => { window.viewModel.loading = false; window.viewModel.error = 'Fixture error'; window.renderView(); });
      await root.locator('.control-error').getByText('Fixture error').waitFor();
      await page.evaluate(() => { window.viewModel.error = null; window.viewModel.hasMore = false; window.viewModel.openingIds = ['published-a']; window.renderView(); });
      assert.equal(await row(0).getByRole('button', { name: await label('editor.published.openingInEditor'), exact: true }).isDisabled(), true);
      assert.equal(await (await button('common.actions.loadMore')).count(), 0, 'pagination hidden when exhausted');
      await page.evaluate(() => { window.viewModel.currentUserSub = ''; window.renderView(); });
      assert.equal(await root.locator('.uploaded-draft-action--danger').count(), 0, 'signed-out model has no Delete');
      await page.evaluate(() => { window.viewModel.items = []; window.renderView(); });
      await root.getByText(await label('common.publishedBrowser.empty'), { exact: true }).waitFor();
      await page.evaluate(() => {
        window.viewCurrent = false;
        document.querySelectorAll('#view-fixture button').forEach(button => button.click());
      });
      assert.equal((await page.evaluate(() => window.viewEvents)).length, 6, 'current-context guard blocks mounted old controls');
      await page.evaluate(() => { window.viewCurrent = true; });
      await (await button('common.actions.close')).click();
      assert.deepEqual((await page.evaluate(() => window.viewEvents)).at(-1), ['close', undefined]);
      await page.evaluate(() => { window.viewModel.open = false; window.renderView(); });
      assert.equal(await root.locator('.confirm-modal').count(), 0);
      await page.evaluate(() => {
        window.viewModel.open = true; window.renderView();
        const buttons = [...document.querySelectorAll('#view-fixture button')];
        window.view.destroy(); buttons.forEach(button => button.click()); window.renderView();
      });
      assert.equal(await root.locator('.confirm-modal').count(), 0);
      assert.equal((await page.evaluate(() => window.viewEvents)).length, 7);
      // Settle the new fixture draft's initial autosave before exercising server UI.
      await page.waitForFunction(() => !window.editorSession.state.autosavePending);
      // Real shell wiring: filter capture, append and refresh must reach the API unchanged.
      const queries = [];
      await context.route(url => url.pathname.endsWith('/session'), route => route.fulfill({ json: { ok: true, data: { ready: true, user: { sub: 'fixture' } } } }));
      await context.route(url => url.pathname.endsWith('/published'), route => {
        const query = Object.fromEntries(new URL(route.request().url()).searchParams);
        queries.push(query);
        const appended = Number(query.offset) > 0;
        return route.fulfill({ json: { ok: true, data: {
          items: [{ published_package_id: appended ? 'page-b' : 'page-a', title: appended ? 'Page B' : 'Page A', owner_sub: 'fixture' }],
          hasMore: !appended, nextOffset: appended ? null : 20,
        } } });
      });
      await page.evaluate(async () => {
        await window.editorSession.refreshServerSession();
        document.querySelector('.editor-more-actions').open = true;
      });
      await page.getByRole('button', { name: await label('editor.published.browse'), exact: true }).click();
      const modal = page.locator('.browse-modal');
      await modal.getByText('Page A', { exact: true }).waitFor();
      const filters = modal.locator('.browse-modal__filters input');
      await filters.nth(0).fill('Chosen title'); await filters.nth(1).fill('Math'); await filters.nth(2).fill('owner@example.test');
      await modal.getByRole('button', { name: await label('common.publishedBrowser.searchAriaLabel'), exact: true }).click();
      await modal.getByText('Page A', { exact: true }).waitFor();
      assert.deepEqual([queries.at(-1).title, queries.at(-1).subject, queries.at(-1).owner, Number(queries.at(-1).offset)], ['Chosen title', 'Math', 'owner@example.test', 0]);
      await filters.nth(0).fill('Unsearched edit');
      await modal.getByRole('button', { name: await label('common.actions.loadMore'), exact: true }).click();
      await modal.getByText('Page B', { exact: true }).waitFor();
      assert.equal(await modal.locator('.published-result-row').count(), 2);
      assert.deepEqual([queries.at(-1).title, Number(queries.at(-1).offset)], ['Chosen title', 20]);
      await filters.nth(0).fill('Refreshed title');
      await modal.getByRole('button', { name: await label('common.actions.refresh'), exact: true }).click();
      await modal.getByText('Page A', { exact: true }).waitFor();
      assert.equal(await modal.locator('.published-result-row').count(), 1);
      assert.deepEqual([queries.at(-1).title, Number(queries.at(-1).offset)], ['Refreshed title', 0]);
      await modal.getByRole('button', { name: await label('common.actions.close'), exact: true }).click();
      assert.equal(await modal.count(), 0);
      assert.deepEqual(errors, []);
      console.log(`PASS published view ${locale}/${width}: filters, actions, ownership, busy/error/empty states and disposal`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
