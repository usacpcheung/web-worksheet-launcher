import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
      await page.addInitScript(locale => {
        localStorage.setItem('worksheetLauncher.locale', locale);
        window.printDocuments = [];
        window.open = () => ({ opener: window, document: {
          open() {}, write(html) { window.printDocuments.push(html); }, close() {},
        } });
      }, locale);
      await page.goto(`${base}/server/roleplayscene/`);
      await page.locator('[data-focus-key="project-title"]').waitFor();
      await page.locator('#file-input').setInputFiles({
        name: 'print-fixture.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ meta: { title: 'Print fixture' }, scenes: [
          { id: 'start', type: 'start', dialogue: [{ text: 'Welcome' }], choices: [{ label: 'Finish', nextSceneId: 'end' }] },
          { id: 'end', type: 'end', dialogue: [{ text: 'Done' }], choices: [] },
        ] })),
      });
      await page.locator('#import-confirm-accept').click();
      await page.waitForFunction(() => document.querySelector('#file-input').value === '');
      await page.locator('#mode-play').click();
      await page.locator('.player-intro-begin').click();
      const utilities = page.locator('.theater-utilities-toggle');
      const discussionButtons = page.locator('.theater-utilities-section--discussion button');
      await utilities.click();
      assert.equal(await discussionButtons.nth(1).isDisabled(), true, 'empty discussion cannot print');
      await discussionButtons.first().click();
      await page.locator('.player-discussion-textarea').fill('My discussion <safe> & complete.');
      await page.keyboard.press('Escape');
      const openPrint = async () => { await utilities.click(); await discussionButtons.nth(1).click(); };
      await openPrint();
      const overlay = page.locator('#server-modal-overlay');
      const inputs = overlay.locator('.discussion-print-details-form__input');
      const modes = overlay.locator('.discussion-print-details-form__mode-button');
      const actions = page.locator('#server-modal-actions button');
      await overlay.waitFor();
      assert.equal(await inputs.first().evaluate(node => node.readOnly), true);
      const defaultName = await inputs.first().inputValue();
      assert.ok(defaultName.length > 0);
      assert.equal(await modes.first().getAttribute('aria-pressed'), 'true');
      await modes.nth(1).click();
      assert.equal(await inputs.first().evaluate(node => node === document.activeElement), true);
      await inputs.first().fill('Custom school');
      await inputs.nth(1).fill('Student A');
      await actions.first().click();
      assert.equal(await page.evaluate(() => window.printDocuments.length), 0);
      await openPrint();
      assert.equal(await inputs.first().inputValue(), defaultName, 'cancelled details are not remembered');
      assert.equal(await inputs.nth(1).inputValue(), '');
      await modes.nth(1).click();
      await inputs.first().fill('Custom school');
      await inputs.nth(1).fill('Student A');
      if (shots) await page.screenshot({ path: `${shots}/print-details-${locale}-${width}.png` });
      await actions.nth(1).click();
      const html = await page.evaluate(() => window.printDocuments[0]);
      for (const text of ['Print fixture', 'Custom school', 'Student A', 'My discussion &lt;safe&gt; &amp; complete.']) assert.ok(html.includes(text), text);
      assert.equal(await overlay.isVisible(), false);
      await openPrint();
      assert.equal(await inputs.first().inputValue(), 'Custom school');
      assert.equal(await inputs.nth(1).inputValue(), 'Student A');
      // Locale changes preserve custom text, but update the default school name.
      const nextLocale = locale === 'en' ? 'zh-Hant' : 'en';
      await page.evaluate(async next => (await import('./scripts/i18n.js')).setActiveLocale(next), nextLocale);
      assert.equal(await inputs.first().inputValue(), 'Custom school');
      await modes.first().click();
      assert.equal(await inputs.first().inputValue(), await page.evaluate(async () => (await import('./scripts/i18n.js')).translate('player.discussion.defaultSchoolName')));
      const closedValue = await inputs.first().inputValue();
      await inputs.first().evaluate(node => { window.closedSchoolInput = node; });
      await page.keyboard.press('Escape');
      assert.equal(await overlay.isVisible(), false);
      assert.equal(await page.evaluate(() => window.printDocuments.length), 1);
      await page.evaluate(async next => (await import('./scripts/i18n.js')).setActiveLocale(next), locale);
      assert.equal(await page.evaluate(() => window.closedSchoolInput.value), closedValue, 'closing unsubscribes the old form from locale changes');
      await openPrint();
      await modes.nth(1).click();
      await inputs.first().fill('');
      await inputs.nth(1).fill('');
      // Modules already loaded: local printing remains available after connection loss.
      await context.setOffline(true);
      await page.locator('.discussion-print-details-form').evaluate(form => form.requestSubmit());
      assert.equal(await page.evaluate(() => window.printDocuments.length), 2);
      await openPrint();
      assert.equal(await modes.first().getAttribute('aria-pressed'), 'true', 'empty custom name falls back to default');
      assert.equal(await inputs.nth(1).inputValue(), '');
      await page.locator('#server-modal-close').click();
      await page.evaluate(() => { window.open = () => null; });
      await openPrint();
      await actions.nth(1).click();
      assert.equal(await page.locator('.app-messages__text').textContent(), await page.evaluate(async () => (await import('./scripts/i18n.js')).translate('player.discussion.printPopupBlocked')));
      assert.deepEqual(errors, []);
      console.log(`PASS print integration ${locale}/${width}: cancel, details, locale, escaped output, offline, blocked popup`);
    } finally { await context.close(); }
  }

  // Explicitly exercise the controller's busy guards before and after the details await.
  const context = await browser.newContext();
  try {
    await context.route('**/roleplayscene/scripts/main.js', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
    const page = await context.newPage();
    await page.goto(`${base}/server/roleplayscene/`);
    const result = await page.evaluate(async () => {
      const { createDiscussionPrintController } = await import('./scripts/player/discussion-print-controller.js');
      const events = [];
      let options, hasText = true;
      const session = { voice: { active: {} }, bindProject() {}, hasAnyText: () => hasText, snapshot: () => ({}) };
      const controller = createDiscussionPrintController({
        getActiveProject: () => ({ meta: { title: 'Guard fixture' }, scenes: [] }),
        discussionSession: session, showMessage: message => events.push(message),
        dialogs: { isAvailable: () => true, open: value => { options = value; events.push('dialog'); }, close: () => options.onClose() },
      });
      window.open = () => { events.push('popup'); return null; };
      await controller.print();
      const before = events.splice(0);
      session.voice.active = null;
      hasText = false;
      await controller.print();
      const empty = events.splice(0);
      hasText = true;
      const pending = controller.print();
      session.voice.active = {};
      options.actions[1].onClick();
      await pending;
      const after = events.splice(0);
      session.voice.active = null;
      const closed = controller.print();
      options.onClose();
      await closed;
      return { before, empty, after, closed: events };
    });
    assert.deepEqual(result.before, [{ textId: 'player.discussion.printBusy' }]);
    assert.equal(result.empty.length, 1);
    assert.ok(result.empty[0].text);
    assert.deepEqual(result.after, ['dialog', { textId: 'player.discussion.printBusy' }]);
    assert.deepEqual(result.closed, ['dialog'], 'replaced/closed dialog settles without printing');
    console.log('PASS print controller: empty and busy guards, close settlement');
  } finally { await context.close(); }
} finally { await browser.close(); }
