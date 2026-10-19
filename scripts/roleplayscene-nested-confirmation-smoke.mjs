// Real main.js handlers and IndexedDB, isolated contexts, synthetic local files.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createStoredZip } from '../server/editor/zip-utils.js';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function fixture(title) {
  return { name: `${title}.zip`, mimeType: 'application/zip', buffer: Buffer.from(createStoredZip([
    { path: 'manifest.json', data: JSON.stringify({ format: 'roleplayscene-package', packageVersion: 1, assets: [] }) },
    { path: 'content/project.json', data: JSON.stringify({ meta: { title }, scenes: [
      { id: 'scene-021', type: 'start', speechBubble: { enabled: false }, image: { name: 'cover.png', type: 'image/png', path: 'media/cover.png' },
        dialogue: [{ text: `Dialogue ${title}` }], choices: [{ id: 'choice-0017', label: 'Finish', nextSceneId: 'scene-022' }] },
      { id: 'scene-022', type: 'end', dialogue: [], choices: [] },
    ] }) },
    { path: 'media/cover.png', data: png },
  ])) };
}

const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      let artifacts = 0;
      await context.route(url => url.pathname.startsWith('/api/'), async route => {
        if (new URL(route.request().url()).pathname.endsWith('/artifact')) {
          artifacts++;
          return route.fulfill({ contentType: 'application/zip', body: fixture('Incoming').buffer });
        }
        return route.fulfill({ json: { ok: true, data: { ready: true, user: { sub: 'qa' }, items: [
          { roleplayscene_uploaded_draft_id: '11111111-1111-4111-8111-111111111111', title: 'Incoming' },
        ] } } });
      });
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.goto(base + '/server/roleplayscene/index.html');
      await page.locator('#file-input').setInputFiles(fixture('Original'));
      await page.locator('#import-confirm-accept').click();
      await page.waitForFunction(() => document.querySelector('#file-input').value === '');
      await page.locator('#mode-play').click();
      await page.locator('.player-intro-begin').click();
      await page.locator('.theater-utilities-toggle').click().catch(async error => { console.log(await page.locator('body').innerText()); throw error; });
      await page.locator('.theater-utilities-section--discussion button').first().click();
      await page.locator('.player-discussion-textarea').fill('Keep this discussion');
      // Closing the panel retains its draft discussion text.
      await page.keyboard.press('Escape');
      if (!await page.locator('#server-manage-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
      await page.locator('#server-manage-btn').click();
      const manager = page.locator('#server-modal-overlay');
      const prompt = page.locator('#import-confirm-overlay');
      const open = page.locator('[data-draft-action="open"]');
      for (const cancel of ['button', 'escape']) {
        await open.click();
        await prompt.waitFor({ state: 'visible' });
        assert.equal(artifacts, 0);
        assert.equal(await manager.evaluate(el => el.inert), true);
        await page.waitForFunction(() => document.activeElement === document.querySelector('#import-confirm-accept'));
        assert.equal(await page.locator('#import-confirm-accept').evaluate(el => {
          const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2));
        }), true);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#import-confirm-cancel').evaluate(el => el === document.activeElement), true);
        if (cancel === 'button') await page.locator('#import-confirm-cancel').click();
        else await page.keyboard.press('Escape');
        await prompt.waitFor({ state: 'hidden' });
        assert.equal(await manager.isVisible(), true);
        assert.equal(await manager.evaluate(el => el.inert), false);
        await page.waitForFunction(() => document.activeElement?.matches('[data-draft-action="open"]'));
        assert.equal(artifacts, 0);
      }
      await open.click();
      await page.locator('#import-confirm-accept').click();
      await page.waitForFunction(() => document.querySelector('#server-modal-overlay').hidden);
      // Final replacement confirmation is separate from discussion consent.
      await prompt.waitFor({ state: 'visible' });
      assert.equal(artifacts, 1);
      await page.locator('#import-confirm-cancel').click();
      await prompt.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      console.log(`PASS nested discussion consent ${locale}/${width}: pointer, Tab, Escape, cancel and consent-before-download`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
