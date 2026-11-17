// Isolated fixtures only: exercise dialog behavior and the actual editor publish loop.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      let published = false;
      const posts = [];
      await context.route(url => url.pathname.startsWith('/api/'), route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/session')) return route.fulfill({ json: { ok: true, data: { ready: true, user: { sub: 'fixture' } } } });
        if (url.pathname.endsWith('/published') && route.request().method() === 'POST') {
          posts.push(route.request().postDataJSON());
          if (posts.length === 1) return route.fulfill({ status: 409, json: { ok: false, error: { code: 'PUBLISHED_PACKAGE_CONFLICT' } } });
          published = true;
          return route.fulfill({ json: { ok: true, data: { published_package_id: 'published-fixture' } } });
        }
        return route.fulfill({ json: { ok: true, data: { items: [{ uploaded_draft_id: 'fixture', title: 'Original title', subject: 'Original subject', created_at: '2026-11-17T00:00:00Z', publish_state: published ? 'current_version_published' : 'draft_only' }] } } });
      });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession?.state.serverSession.status === 'ready');
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      // Test the standalone view with production styles/translations and real DOM events.
      await page.evaluate(async () => {
        const { createEditorDialogs } = await import('/server/editor/dialogs.js');
        const { t } = await import('/server/app/i18n/index.js');
        const host = document.createElement('div'); host.id = 'dialog-fixture'; host.className = 'editor-shell';
        const trigger = document.createElement('button'); trigger.id = 'fixture-trigger'; trigger.textContent = 'Open fixture';
        host.append(trigger); document.body.append(host); trigger.focus();
        let id = 0;
        window.dialogFixture = createEditorDialogs({ host, t, createLocalId: () => `fixture-${++id}`, formatUploadedDraftTimestamp: value => value });
      });
      const fixture = page.locator('#dialog-fixture'), dialog = fixture.getByRole('dialog');
      const open = (method, options = {}) => page.evaluate(({ method, options }) => {
        window.dialogResult = undefined;
        window.dialogFixture[method](options).then(value => { window.dialogResult = value; });
      }, { method, options });
      const result = async () => {
        await page.waitForFunction(() => window.dialogResult !== undefined);
        return page.evaluate(() => window.dialogResult);
      };
      const focused = locator => locator.evaluate(el => el === document.activeElement);
      await open('showConfirmDialog', { title: 'Fixture', bodyText: 'Body wins', descriptionText: 'Other description', removalItems: ['<b>Literal</b>'] });
      assert.equal(await dialog.locator('.confirm-modal__description').textContent(), 'Body wins');
      assert.equal(await dialog.locator('li').textContent(), '<b>Literal</b>');
      assert.equal(await dialog.locator('li b').count(), 0);
      assert.equal(await dialog.locator('.confirm-modal__warning').textContent(), await label('editor.modal.confirm.irreversibleWarning'));
      assert.equal(await dialog.locator('.confirm-modal__btn--destructive').count(), 1);
      assert.equal(await focused(dialog.locator('button').first()), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focused(dialog.locator('button').last()), true);
      await page.keyboard.press('Tab');
      assert.equal(await focused(dialog.locator('button').first()), true);
      await page.keyboard.press('Enter');
      assert.equal(await result(), false);
      assert.equal(await focused(page.locator('#fixture-trigger')), true);
      for (const options of [{ descriptionText: 'Description only' }, { entityLabel: 'Fixture entity' }, {}]) {
        await open('showConfirmDialog', { title: 'Fixture', ...options });
        const description = await dialog.locator('.confirm-modal__description').textContent();
        assert.ok(description.length > 0);
        if (options.descriptionText) assert.equal(description, options.descriptionText);
        if (options.entityLabel) assert.ok(description.includes(options.entityLabel));
        await page.keyboard.press('Escape'); assert.equal(await result(), false);
      }
      await page.evaluate(() => {
        const content = document.createElement('input'); content.id = 'embedded-choice';
        window.dialogFixture.showConfirmDialog({ title: 'Embedded control', content, variant: 'warning', warningText: '' }).then(value => { window.embeddedResult = value; });
      });
      assert.equal(await dialog.locator('.confirm-modal__warning').count(), 0);
      assert.equal(await dialog.locator('.confirm-modal__btn--warning').count(), 1);
      assert.equal(await dialog.locator('.confirm-modal__btn--destructive').count(), 0);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focused(dialog.locator('input')), true);
      await dialog.locator('button').last().click();
      assert.equal(await page.evaluate(() => window.embeddedResult), true);
      await open('showConfirmDialog', { title: 'Warning', variant: 'warning', warningText: 'Caution text' });
      assert.equal(await dialog.locator('.confirm-modal__warning--caution').textContent(), 'Caution text');
      await dialog.locator('button').first().click(); assert.equal(await result(), false);
      // Replacing a confirmation cancels the first; its old button cannot close the second.
      await open('showConfirmDialog', { title: 'First' });
      await dialog.locator('button').last().evaluate(el => { window.oldConfirm = el; });
      await page.evaluate(() => {
        window.dialogFixture.showConfirmDialog({ title: 'Second' }).then(value => { window.secondResult = value; });
        window.oldConfirm.click();
      });
      assert.equal(await result(), false);
      assert.equal(await dialog.locator('h3').textContent(), 'Second');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => window.secondResult), false);
      await open('showPublishModal', { uploadedDraft: { title: 'Fallback title', subject: 'Fallback subject' }, initialTitle: '', initialSubject: '' });
      assert.equal(await dialog.locator('input').first().inputValue(), '');
      assert.equal(await focused(dialog.locator('input').first()), true);
      await page.keyboard.press('Shift+Tab'); assert.equal(await focused(dialog.locator('button').last()), true);
      await page.keyboard.press('Tab'); assert.equal(await focused(dialog.locator('input').first()), true);
      await dialog.locator('input').first().fill('Edited title'); await dialog.locator('input').last().fill('Edited subject');
      await dialog.locator('button').last().click();
      assert.deepEqual(await result(), { confirmed: true, title: 'Edited title', subject: 'Edited subject' });
      for (const method of ['showPublishModal', 'showPublishedPackageConflictModal', 'showUploadConflictModal']) {
        await open(method, { uploadedDraft: { title: 'Fallback title', subject: 'Fallback subject' }, existingDraft: { title: 'Existing', published_package_id: 'published' } });
        if (method === 'showPublishModal') assert.equal(await dialog.locator('input').first().inputValue(), 'Fallback title');
        if (method === 'showPublishedPackageConflictModal') assert.equal(await focused(dialog.locator('button').last()), true);
        await page.keyboard.press('Escape');
        assert.deepEqual(await result(), method === 'showPublishModal' ? { confirmed: false } : { action: 'cancel' });
      }
      for (const [index, action] of ['cancel', 'copy', 'replace'].entries()) {
        await open('showUploadConflictModal', { existingDraft: { title: 'Existing', subject: 'Math', created_at: '2026-11-17', published_package_id: 'published' } });
        assert.equal(await focused(dialog.locator('button').first()), true);
        if (process.env.VIEWER_SMOKE_SCREENSHOTS && action === 'copy') {
          await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
          await dialog.screenshot({ path: path.join(process.env.VIEWER_SMOKE_SCREENSHOTS, `upload-conflict-${locale}-${width}.png`) });
        }
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        await dialog.locator('button').nth(index).click();
        assert.deepEqual(await result(), { action });
      }
      await page.evaluate(async () => {
        const d = window.dialogFixture;
        const results = [d.showPublishModal({}), d.showPublishedPackageConflictModal(), d.showUploadConflictModal({}), d.showConfirmDialog({ title: 'Pending' })];
        window.staleDialogButtons = [...document.querySelectorAll('#dialog-fixture .confirm-modal button')];
        d.destroy(); d.destroy();
        window.disposedResults = await Promise.all(results);
        window.staleDialogButtons.forEach(button => button.click());
      });
      assert.deepEqual(await page.evaluate(() => window.disposedResults), [{ confirmed: false }, { action: 'cancel' }, { action: 'cancel' }, false]);
      assert.equal(await dialog.count(), 0);
      assert.equal(await page.evaluate(() => window.dialogFixture.isConfirmationOpen()), false);
      await open('showConfirmDialog', { title: 'After disposal' }); assert.equal(await result(), false);
      await page.evaluate(() => document.querySelector('#dialog-fixture').remove());
      // Actual manager -> publish -> conflict -> edit -> publish, including cancel without POST.
      await page.locator('details.editor-more-actions').evaluate(el => { el.open = true; });
      await page.getByRole('button', { name: await label('editor.uploadedDraft.manage'), exact: true }).click();
      const manager = page.locator('.browse-modal');
      const publish = manager.getByRole('button', { name: await label('common.actions.publish'), exact: true });
      const form = page.locator('.confirm-modal').filter({ has: page.locator('.confirm-modal__actions--publish') });
      await publish.click(); await form.waitFor();
      await page.keyboard.press('Escape'); await form.waitFor({ state: 'detached' });
      assert.equal(posts.length, 0);
      await publish.click(); await form.locator('input').first().fill('First title');
      await form.locator('input').last().fill('First subject'); await form.locator('button').last().click();
      await page.getByRole('button', { name: await label('editor.modal.publishConflict.editNameSubject'), exact: true }).click();
      assert.equal(await form.locator('input').first().inputValue(), 'First title');
      assert.equal(await form.locator('input').last().inputValue(), 'First subject');
      await form.locator('input').first().fill('Unique title'); await form.locator('button').last().click();
      await page.waitForFunction(() => !window.editorSession._publishMenuBusy && window.editorSession.state.lastPublishedPackage?.published_package_id === 'published-fixture');
      assert.equal(posts.length, 2);
      assert.deepEqual(posts.map(({ title, subject }) => ({ title, subject })), [{ title: 'First title', subject: 'First subject' }, { title: 'Unique title', subject: 'First subject' }]);
      await manager.getByRole('button', { name: await label('common.actions.close'), exact: true }).click();
      // Shell replacement settles a real pending confirmation without applying a text reduction.
      await page.evaluate(() => {
        const s = window.editorSession;
        s.state.draft.blocks = [{ blockId: 'text', kind: 'question', position: 0, prompt: { text: 'Fixture' }, responseConfig: { inputType: 'text', textMode: 'long', maxLength: 15000, displayMode: 'multi_line' } }];
        s.selectBlock('text'); s.touchDraft(); s.notifyStateChange();
      });
      await page.locator('#editor-question-long-text').click();
      await page.getByRole('dialog').locator('button').last().evaluate(el => { window.oldShellConfirm = el; });
      await page.locator('.language-selector select').evaluate((el, locale) => { el.value = locale; el.dispatchEvent(new Event('change', { bubbles: true })); }, locale === 'en' ? 'zh-Hant' : 'en');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.evaluate(() => window.oldShellConfirm.click());
      assert.deepEqual(await page.evaluate(() => {
        const c = window.editorSession.findBlock('text').responseConfig; return [c.textMode, c.maxLength];
      }), ['long', 15000]);
      assert.deepEqual(errors, []);
      console.log(`PASS editor dialogs ${locale}/${width}: choices, focus, disposal, publication retry and shell replacement`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
