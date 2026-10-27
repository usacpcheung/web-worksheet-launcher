import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const app of ['editor', 'roleplayscene']) for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    for (const scenario of ['conflict', 'cancel', 'lost-response', 'refresh-failure']) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        const errors = [], posts = []; let refreshes = 0;
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
        const row = { uploaded_draft_id: 'fixture', roleplayscene_uploaded_draft_id: 'fixture', title: 'Fixture', subject: 'Subject', description: 'Description', publish_state: 'draft_only', owner_sub: 'fixture' };
        await page.route(url => url.pathname.startsWith('/api/'), async route => {
          const req = route.request(), path = new URL(req.url()).pathname;
          if (path.endsWith('/session')) return route.fulfill({ json: { ok: true, data: { ready: true, user: { sub: 'fixture' } } } });
          if (req.method() === 'POST') {
            posts.push(req.postDataJSON());
            if (scenario === 'lost-response') return route.abort('connectionreset');
            if (scenario === 'conflict' && posts.length === 1) return route.fulfill({ status: 409, json: { ok: false, error: { code: app === 'editor' ? 'PUBLISHED_PACKAGE_CONFLICT' : 'ROLEPLAYSCENE_PUBLISHED_TITLE_CONFLICT' } } });
            return route.fulfill({ json: { ok: true, data: { published_package_id: 'saved', roleplayscene_published_scene_id: 'saved' } } });
          }
          if (posts.length) {
            refreshes++;
            if (scenario === 'refresh-failure') return route.fulfill({ status: 503, json: { ok: false, error: { code: 'SERVICE_UNAVAILABLE' } } });
          }
          return route.fulfill({ json: { ok: true, data: { items: [row] } } });
        });
        await page.goto(`${base}/server/${app}/`);
        const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
        if (app === 'editor') {
          await page.waitForFunction(() => window.editorSession);
          await page.locator('details').evaluateAll(nodes => nodes.forEach(n => { n.open = true; }));
          await page.getByRole('button', { name: await label('editor.uploadedDraft.manage'), exact: true }).click();
        } else {
          if (!await page.locator('#server-manage-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
          await page.locator('#server-manage-btn').click();
        }
        const action = app === 'editor' ? page.locator('.browse-modal').getByRole('button', { name: await label('common.actions.publish'), exact: true }).first() : page.locator('[data-draft-action="publish"]').first();
        await action.click();
        const form = () => app === 'editor' ? page.getByRole('dialog').last() : page.locator('#server-modal-overlay');
        const primary = () => form().locator(app === 'editor' ? '.confirm-modal__btn--primary' : '.confirm-actions__primary');
        const secondary = () => form().locator(app === 'editor' ? '.confirm-modal__btn:not(.confirm-modal__btn--primary)' : '.confirm-actions__secondary').last();
        await form().locator('input').first().fill('Taken');
        await form().locator(app === 'editor' ? 'input' : 'textarea').last().fill('Retained metadata');
        // Real dialogs retain keyboard focus within the active form.
        await page.keyboard.press('Tab');
        assert.equal(await form().evaluate(node => node.contains(document.activeElement)), true);
        if (scenario === 'cancel') {
          await secondary().click();
          if (app === 'roleplayscene') {
            if (!await page.locator('#server-manage-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
            await page.locator('#server-manage-btn').click();
          }
          await action.click();
          await secondary().click();
          assert.equal(posts.length, 0);
        } else {
          // Two synchronous clicks on the original control must still send once.
          await primary().evaluate(button => { button.click(); button.click(); });
          if (scenario === 'conflict') {
            const edit = app === 'editor' ? form().locator('.confirm-modal__btn--destructive') : primary();
            await edit.click();
            assert.equal(await form().locator('input').first().inputValue(), 'Taken');
            assert.equal(await form().locator(app === 'editor' ? 'input' : 'textarea').last().inputValue(), 'Retained metadata');
            assert.equal(posts.length, 1);
            await form().locator('input').first().fill('Renamed');
            await primary().click();
          }
          const expected = scenario === 'conflict' ? 2 : 1;
          await page.waitForFunction(({app}) => app === 'editor'
            ? !window.editorSession._publishMenuBusy && window.editorSession.state.publishingDraftIds.size === 0
            : !document.querySelector('[data-draft-action="publish"]')?.disabled, {app});
          assert.equal(posts.length, expected);
          assert.equal(posts.at(-1)[app === 'editor' ? 'subject' : 'description'], 'Retained metadata');
          if (scenario === 'conflict') assert.equal(posts.at(-1).title, 'Renamed');
          if (scenario === 'lost-response') assert.equal(refreshes, 0);
          else assert.ok(refreshes > 0);
          if (scenario === 'refresh-failure' && app === 'editor') {
            assert.equal(await page.evaluate(() => window.editorSession.state.lastPublishedPackage.published_package_id), 'saved');
            assert.ok(await page.evaluate(() => window.editorSession.state.notifications.some(n => n.source === 'publish.refresh' && n.kind === 'warn')));
          }
        }
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        console.log(`PASS publication ${app}/${locale}/${width}/${scenario}`);
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }
