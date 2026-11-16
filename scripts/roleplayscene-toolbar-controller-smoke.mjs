import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    try {
      // Exercise the exported controller with the real markup/CSS, without app services.
      await context.route('**/roleplayscene/scripts/main.js', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/server/roleplayscene/`);
      await page.evaluate(async locale => {
        const { createToolbarController } = await import('./scripts/ui/toolbar-controller.js');
        const { setActiveLocale, translate } = await import('./scripts/i18n.js');
        setActiveLocale(locale);
        window.translate = translate;
        window.localeChanges = [];
        window.toolbarState = {
          inPublishedPlay: false, inEditorPreview: false,
          serverSession: { status: 'not_ready', user: null },
          isOpeningDraft: false, isUploadingDraft: false,
          isLoadingUploadedDrafts: false, isLoadingPublishedScenes: false,
        };
        window.toolbarController = createToolbarController({ onLocaleChange: value => window.localeChanges.push(value) });
        window.renderToolbar = changes => {
          Object.assign(window.toolbarState, changes);
          window.toolbarController.render(window.toolbarState);
        };
        window.savedControls = ['new-story-btn', 'import-btn', 'export-btn', 'server-signin-btn', 'server-save-btn', 'locale-select']
          .map(id => document.getElementById(id));
        window.newStoryClicks = 0;
        document.getElementById('new-story-btn').addEventListener('click', () => window.newStoryClicks++);
        window.toolbarController.populateLocaleOptions(locale);
        window.toolbarController.setMode('edit');
        window.renderToolbar({});
      }, locale);
      const more = page.locator('#toolbar-more-btn');
      const menu = page.locator('#toolbar-more-menu');
      const widths = [390, 767, 768, 900, 1023, 1024, 1600, 390, 1600];
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(width => {
          const parent = document.getElementById('new-story-btn').parentElement;
          return width > 1023 ? parent.classList.contains('toolbar__files') : parent.id === 'toolbar-more-project-items';
        }, width);
        assert.equal(await page.evaluate(() => window.savedControls.every(node => node === document.getElementById(node.id))), true);
        assert.equal(await page.locator('#locale-select').inputValue(), locale);
        assert.equal(await page.evaluate(() => Number.parseFloat(document.documentElement.style.getPropertyValue('--roleplayscene-topbar-height')) >= document.querySelector('.topbar').getBoundingClientRect().height), true);
        if (width <= 1023) {
          assert.equal(await page.locator('#server-signin-btn').evaluate(node => node.parentElement.id === 'toolbar-more-server-items'), width < 768);
          await more.focus();
          await page.keyboard.press('Enter');
          await page.locator('#new-story-btn').click();
          assert.equal(await menu.isVisible(), false);
          await more.click();
          await page.keyboard.press('Escape');
          assert.equal(await more.getAttribute('aria-expanded'), 'false');
          await more.click();
          await page.locator('.topbar h1').click();
          assert.equal(await menu.isVisible(), false);
        } else {
          await page.locator('#new-story-btn').click();
        }
      }
      assert.equal(await page.evaluate(() => window.newStoryClicks), widths.length, 'reparenting keeps exactly one action handler');
      await page.evaluate(() => {
        document.querySelector('.toolbar').style.width = '500px';
        document.querySelector('.toolbar').style.flex = '0 0 500px';
        window.renderToolbar({});
      });
      assert.equal(await more.isVisible(), true, 'desktop wrapping uses overflow fallback');
      assert.equal(await page.locator('#server-save-btn').evaluate(node => node.parentElement.id), 'toolbar-more-server-items');
      await page.evaluate(() => { document.querySelector('.toolbar').removeAttribute('style'); window.renderToolbar({}); });
      await page.evaluate(() => window.renderToolbar({
        serverSession: { status: 'ready', user: { email: 'fixture@example.test' } },
        isOpeningDraft: true, isUploadingDraft: true, isLoadingUploadedDrafts: true, isLoadingPublishedScenes: true,
      }));
      assert.equal(await page.locator('#server-signin-btn').isVisible(), false);
      assert.match(await page.locator('#server-status').textContent(), /fixture@example.test/);
      for (const id of ['server-save-btn', 'server-manage-btn', 'server-browse-published-btn']) assert.equal(await page.locator(`#${id}`).isDisabled(), true);
      assert.equal(await page.locator('#server-save-btn').getAttribute('aria-busy'), 'true');
      assert.equal(await page.locator('#server-save-btn').textContent(), await page.evaluate(() => window.translate('server.cancelUpload')));
      await page.evaluate(() => window.renderToolbar({ inEditorPreview: true, isOpeningDraft: false }));
      assert.equal(await page.locator('#mode-play').isVisible(), false);
      assert.equal(await page.locator('#mode-edit').textContent(), await page.evaluate(() => window.translate('toolbar.backToEdit')));
      await page.evaluate(() => window.renderToolbar({ inEditorPreview: false, inPublishedPlay: true }));
      for (const id of ['mode-edit', 'new-story-btn', 'import-btn', 'export-btn', 'server-save-btn', 'server-manage-btn']) {
        assert.equal(await page.locator(`#${id}`).evaluate(node => node.hidden), true);
      }
      assert.equal(await page.locator('#mode-play').isDisabled(), true);
      assert.equal(await page.locator('#published-exit-btn').evaluate(node => node.hidden), false);
      await page.evaluate(() => window.renderToolbar({ inPublishedPlay: false, isUploadingDraft: false, isLoadingUploadedDrafts: false, isLoadingPublishedScenes: false }));
      await page.setViewportSize({ width: 390, height: 900 });
      await more.click();
      const nextLocale = locale === 'en' ? 'zh-Hant' : 'en';
      await page.locator('#locale-select').selectOption(nextLocale);
      assert.deepEqual(await page.evaluate(() => window.localeChanges), [nextLocale]);
      await page.locator('#locale-select').focus();
      await page.evaluate(() => window.toolbarController.updateDraftAvailability({
        isOpeningDraft: true, isLoadingUploadedDrafts: false, isLoadingPublishedScenes: false,
      }));
      for (const id of ['new-story-btn', 'import-btn', 'server-save-btn', 'server-manage-btn', 'server-browse-published-btn']) {
        assert.equal(await page.locator(`#${id}`).isDisabled(), true);
      }
      assert.equal(await menu.isVisible(), true, 'draft progress does not close overflow');
      assert.equal(await page.locator('#locale-select').evaluate(node => node === document.activeElement), true, 'draft progress does not move focus');
      await page.evaluate(() => window.toolbarController.updateDraftAvailability({
        isOpeningDraft: false, isLoadingUploadedDrafts: false, isLoadingPublishedScenes: false,
      }));
      for (const id of ['new-story-btn', 'import-btn', 'server-save-btn', 'server-manage-btn', 'server-browse-published-btn']) {
        assert.equal(await page.locator(`#${id}`).isDisabled(), false);
      }
      await page.evaluate(() => window.renderToolbar({ serverSession: { status: 'checking' } }));
      assert.equal(await page.locator('#locale-select').evaluate(node => node === document.activeElement), true, 'status refresh keeps locale focus');
      assert.equal(await page.locator('#server-status').textContent(), await page.evaluate(() => window.translate('server.statusChecking')));
      // No detached listener remains after disposal; a fresh controller handles one click.
      await page.evaluate(() => window.toolbarController.destroy());
      await more.click();
      assert.equal(await menu.isVisible(), true, 'disposed controller does not toggle the menu');
      await page.evaluate(async () => {
        const { createToolbarController } = await import('./scripts/ui/toolbar-controller.js');
        window.toolbarController = createToolbarController({ onLocaleChange: () => {} });
      });
      await more.click();
      assert.equal(await menu.isVisible(), false);
      assert.deepEqual(errors, []);
      console.log(`PASS toolbar ${locale}: resize, identity, overflow, modes, busy states, locale and disposal`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
