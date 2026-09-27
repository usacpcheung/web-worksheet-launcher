// Real editor, isolated storage, synthetic packages and controlled audio timing.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createStoredZip } from '../server/editor/zip-utils.js';
import { unzipSync } from '../server/roleplayscene/scripts/vendor/fflate.module.js';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const fixture = title => ({ meta: { title }, scenes: [
  { id: 'start', type: 'start', dialogue: [{ text: 'Hello' }], choices: [{ id: 'next', label: 'Next', nextSceneId: 'end' }] },
  { id: 'end', type: 'end', dialogue: [], choices: [] },
] });
const oldServerTitle = '舊故事'.repeat(20);
const oldServerZip = Buffer.from(createStoredZip([
  { path: 'manifest.json', data: JSON.stringify({ format: 'roleplayscene-package', packageVersion: 1 }) },
  { path: 'content/project.json', data: JSON.stringify(fixture(oldServerTitle)) },
]));
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      let pendingAudio, uploaded;
      await context.route(url => url.pathname.startsWith('/api/'), async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/t2a')) { pendingAudio = route; return; }
        if (path.endsWith('/artifact')) { await route.fulfill({ contentType: 'application/zip', body: oldServerZip }); return; }
        if (path.endsWith('/drafts/upload')) uploaded = route.request().postDataBuffer();
        const item = { title: oldServerTitle, owner_sub: 'fixture' };
        if (path.endsWith('/roleplayscene/drafts')) item.roleplayscene_uploaded_draft_id = '11111111-1111-4111-8111-111111111111';
        if (path.endsWith('/roleplayscene/published')) item.roleplayscene_published_scene_id = '11111111-1111-4111-8111-111111111111';
        await route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [item], uploadedDraftId: 'fixture' } } });
      });
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(base + '/server/roleplayscene/index.html');
      const field = page.locator('[data-focus-key="project-title"]');
      const importProject = async title => {
        await page.locator('#file-input').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture(title))) });
        await page.locator('#import-confirm-accept').click();
        await page.locator('#import-confirm-overlay').waitFor({ state: 'hidden' });
      };
      const snapshot = () => page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('roleplayscene');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction('project').objectStore('project').get('snapshot');
          read.onsuccess = () => { db.close(); resolve(read.result); };
          read.onerror = () => { db.close(); reject(read.error); };
        };
      }));
      const waitSaved = async expected => {
        for (let i = 0; i < 100; i++) {
          if ((await snapshot())?.meta.title === expected) return;
          await page.waitForTimeout(25);
        }
        assert.equal((await snapshot())?.meta.title, expected);
      };
      const exported = async () => {
        if (!await page.locator('#export-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
        const downloadPromise = page.waitForEvent('download');
        await page.locator('#export-btn').click();
        const download = await downloadPromise;
        const files = unzipSync(new Uint8Array(await readFile(await download.path())));
        return JSON.parse(new TextDecoder().decode(files['content/project.json']));
      };
      const upload = async () => {
        if (!await page.locator('#server-save-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
        const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/roleplayscene/drafts/upload'));
        await page.locator('#server-save-btn').click();
        await response;
        await page.waitForFunction(() => !document.querySelector('#server-save-btn').disabled);
        const files = unzipSync(new Uint8Array(uploaded));
        return JSON.parse(new TextDecoder().decode(files['content/project.json']));
      };

      await importProject('Original');
      await field.evaluate(el => { globalThis.originalTitleField = el; });
      await field.press('End');
      await field.pressSequentially(' revised');
      assert.equal(await field.inputValue(), 'Original revised');
      assert.equal(await field.evaluate(el => el === globalThis.originalTitleField), true);
      await field.press('ControlOrMeta+z');
      assert.notEqual(await field.inputValue(), 'Original revised');
      await field.press('ControlOrMeta+Shift+z');
      assert.equal(await field.inputValue(), 'Original revised');

      for (const char of ['茶', '🍵']) {
        await field.fill(char.repeat(40));
        assert.equal(await field.getAttribute('aria-invalid'), 'false');
        assert.match(await page.locator('.rps-project-title-hint').textContent(), /40\/40/);
        await waitSaved(char.repeat(40));
        await field.fill(char.repeat(41));
        assert.equal(await field.getAttribute('aria-invalid'), 'true');
        assert.equal(await page.locator('.rps-project-title-error').isVisible(), true);
        assert.equal((await exported()).meta.title, char.repeat(40));
      }
      if (shots) await page.screenshot({ path: `${shots}/title-error-${locale}-${width}.png` });
      assert.equal((await upload()).meta.title, '🍵'.repeat(40), 'server upload also keeps the last valid title');
      await page.locator('.graph-nodes > g').nth(1).click();
      await page.locator('.graph-nodes > g').first().click();
      assert.equal(await field.inputValue(), '🍵'.repeat(41), 'invalid edit survives scene selection');
      await page.locator('.inspector-actions button').first().click();
      await page.locator('#mode-edit').click();
      assert.equal(await field.inputValue(), '🍵'.repeat(41), 'invalid edit survives preview');
      await waitSaved('🍵'.repeat(40));
      await page.reload();
      await field.waitFor();
      assert.equal(await field.inputValue(), '🍵'.repeat(40), 'reload restores the last valid title');

      await field.fill('茶'.repeat(41));
      await importProject('Replacement');
      assert.equal(await field.inputValue(), 'Replacement', 'replacement clears previous transient title');
      await page.locator('.dialogue-t2a-controls button').first().click();
      for (let i = 0; i < 100 && !pendingAudio; i++) await page.waitForTimeout(20);
      assert(pendingAudio);
      await field.focus();
      await field.evaluate(el => {
        globalThis.composingTitleField = el;
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = '茶館相聚';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      });
      await pendingAudio.fulfill({ contentType: 'audio/mpeg', body: Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]) });
      await page.waitForFunction(() => !document.querySelector('.dialogue-t2a-controls button')?.disabled);
      assert.equal(await field.evaluate(el => el === globalThis.composingTitleField && el.isConnected), true);
      assert.equal(await field.inputValue(), '茶館相聚');
      await waitSaved('Replacement');
      await field.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      await waitSaved('茶館相聚');

      const inherited = '舊'.repeat(60) + '\r\n標題';
      await importProject(inherited);
      assert.equal(await field.inputValue(), inherited.replace(/[\r\n]/g, ''));
      assert.equal(await field.getAttribute('aria-invalid'), 'false');
      await field.focus();
      await field.blur();
      assert.equal((await exported()).meta.title, inherited, 'untouched inherited title retains raw line endings');
      await field.press('ControlOrMeta+A');
      await page.keyboard.insertText('Short replacement');
      await waitSaved('Short replacement');
      await field.press('ControlOrMeta+z');
      assert.equal(await field.inputValue(), inherited.replace(/[\r\n]/g, ''));
      assert.equal(await field.getAttribute('aria-invalid'), 'false', 'native undo can restore original long title');
      await waitSaved(inherited);
      await page.reload();
      await field.waitFor();
      assert.equal(await field.inputValue(), inherited.replace(/[\r\n]/g, ''));
      if (shots) await page.screenshot({ path: `${shots}/title-legacy-${locale}-${width}.png` });

      // Existing server drafts and published copies remain editable and resavable.
      for (const published of [false, true]) {
        const opener = page.locator(published ? '#server-browse-published-btn' : '#server-manage-btn');
        if (!await opener.isVisible()) await page.locator('#toolbar-more-btn').click();
        await opener.click();
        await page.locator(published ? '[data-published-edit-id]' : '[data-draft-action="open"]').click();
        await page.locator('#import-confirm-accept').click();
        await page.waitForFunction(() => !document.querySelector('#new-story-btn').disabled);
        const expected = published ? oldServerTitle + (locale === 'en' ? ' (copy)' : '（副本）') : oldServerTitle;
        assert.equal(await field.inputValue(), expected);
        assert.equal(await field.getAttribute('aria-invalid'), 'false');
        assert.equal((await exported()).meta.title, expected);
        assert.equal((await upload()).meta.title, expected);
        await waitSaved(expected);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale} ${width}: Unicode limit, last-valid save/export, preview drafts, undo/redo, IME/audio race, legacy local/server drafts and published copies`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
