// Regression cases use the real editor with isolated storage and controlled API/ZIP timing.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { unzipSync } from '../server/roleplayscene/scripts/vendor/fflate.module.js';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const fixture = name => ({ meta: { title: 'Name state regression' }, scenes: [
  { id: 'scene01', name, type: 'start', dialogue: [{ text: 'Hello' }], choices: [{ id: 'c1', label: 'Next', nextSceneId: 'ending' }] },
  { id: 'ending', type: 'end', dialogue: [], choices: [] },
] });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      let pendingAudio;
      await context.route(url => url.pathname.startsWith('/api/'), async route => {
        if (new URL(route.request().url()).pathname.endsWith('/t2a')) { pendingAudio = route; return; }
        await route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } });
      });
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/server/roleplayscene/index.html');
      assert.equal(await page.title(), 'RolePlayScene');
      const field = page.locator('[data-focus-key^="scene-name-"]');
      await field.waitFor();
      const importProject = async project => {
        await page.locator('#file-input').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
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
      const waitSavedName = async expected => {
        for (let i = 0; i < 100; i++) {
          if ((await snapshot())?.scenes[0].name === expected) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal((await snapshot())?.scenes[0].name, expected);
      };
      const clickExport = async () => {
        if (!await page.locator('#export-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
        await page.locator('#export-btn').click();
      };
      const waitExported = () => page.waitForFunction(async () => {
        const { translate } = await import('./scripts/i18n.js');
        return document.querySelector('.app-messages__text')?.textContent === translate('messages.exportedProject');
      });
      const readDownload = async download => {
        const files = unzipSync(new Uint8Array(await readFile(await download.path())));
        return JSON.parse(new TextDecoder().decode(files['content/project.json']));
      };

      await importProject(fixture('Original'));
      await field.focus();
      await field.evaluate(el => { globalThis.originalNameField = el; });
      await field.press('ControlOrMeta+End');
      await field.pressSequentially(' revised');
      assert.equal(await field.inputValue(), 'Original revised');
      assert.equal(await field.evaluate(el => el === globalThis.originalNameField), true);
      await field.press('ControlOrMeta+z');
      assert.notEqual(await field.inputValue(), 'Original revised', 'native undo changes the text');
      await field.press('ControlOrMeta+Shift+z');
      assert.equal(await field.inputValue(), 'Original revised', 'native redo restores the edit');
      for (let i = 0; i < 20 && await field.inputValue() !== 'Original'; i++) await field.press('ControlOrMeta+z');
      assert.equal(await field.inputValue(), 'Original', 'the complete native undo history remains available');
      await field.fill('Original revised');

      // A hover tooltip can be dismissed while the name field retains keyboard focus.
      await page.locator('.graph-nodes > g').first().hover();
      assert.equal(await page.locator('.graph-scene-tooltip').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.graph-scene-tooltip').isVisible(), false);

      const pendingName = '🍵'.repeat(81);
      await field.fill(pendingName);
      await page.locator('.graph-nodes > g').nth(1).click();
      await page.locator('.graph-nodes > g').first().click();
      assert.equal(await field.inputValue(), pendingName, 'unfinished name survives scene selection');
      await page.locator('.inspector-actions button').first().click();
      await page.locator('#mode-edit').click();
      assert.equal(await field.inputValue(), pendingName, 'unfinished name survives preview');
      assert.equal(await field.getAttribute('aria-invalid'), 'true');
      const draftDownload = page.waitForEvent('download');
      await clickExport();
      assert.equal((await readDownload(await draftDownload)).scenes[0].name, 'Original revised', 'packages contain only the valid name');
      await importProject(fixture('Replacement'));
      assert.equal(await field.inputValue(), 'Replacement', 'reusing scene IDs in another project cannot restore old drafts');

      await page.locator('.dialogue-t2a-controls button').first().click();
      for (let i = 0; i < 100 && !pendingAudio; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert(pendingAudio, 'audio request started');
      await field.focus();
      await field.evaluate(el => {
        globalThis.composingNameField = el;
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = '茶館相聚';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      });
      await pendingAudio.fulfill({ contentType: 'audio/mpeg', body: Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]) });
      await page.waitForFunction(() => !document.querySelector('.dialogue-t2a-controls button')?.disabled);
      assert.equal(await field.evaluate(el => el === globalThis.composingNameField && el.isConnected), true, 'audio completion leaves the composing input attached');
      assert.equal(await field.inputValue(), '茶館相聚');
      assert.equal(await page.locator('.graph-node-title').first().textContent(), 'Replacement', 'uncommitted composition is not saved');
      await field.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      assert.equal(await page.locator('.graph-node-title').first().textContent(), '茶館相聚');
      await waitSavedName('茶館相聚');

      const inherited = 'x'.repeat(41) + '\r\n' + 'y'.repeat(41);
      await importProject(fixture(inherited));
      assert.equal(await field.inputValue(), inherited.replace('\r\n', '\n'));
      assert.equal(await field.getAttribute('aria-invalid'), 'false', 'unchanged long CRLF names are valid');
      await field.focus();
      await field.blur();
      const legacyDownload = page.waitForEvent('download');
      await clickExport();
      assert.equal((await readDownload(await legacyDownload)).scenes[0].name, inherited, 'export preserves the untouched original line endings');
      await field.focus();
      await field.press('ControlOrMeta+A');
      await page.keyboard.insertText('Short replacement');
      await field.press('ControlOrMeta+z');
      assert.equal(await field.inputValue(), inherited.replace('\r\n', '\n'));
      assert.equal(await field.getAttribute('aria-invalid'), 'false', 'undo can restore an inherited long name');
      await waitSavedName(inherited);

      for (const replaceProject of [false, true]) {
        await importProject(fixture('Before export'));
        await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
        await page.evaluate(() => {
          const original = Blob.prototype.arrayBuffer;
          globalThis.releaseExport = null;
          Blob.prototype.arrayBuffer = function (...args) {
            const bytes = original.apply(this, args);
            if (this.type !== 'image/png') return bytes;
            Blob.prototype.arrayBuffer = original;
            return bytes.then(buffer => new Promise(resolve => { globalThis.releaseExport = () => resolve(buffer); }));
          };
        });
        const downloadPromise = page.waitForEvent('download');
        await clickExport();
        await page.waitForFunction(() => typeof globalThis.releaseExport === 'function');
        const expected = replaceProject ? 'Different project' : 'Renamed during export';
        if (replaceProject) await importProject(fixture(expected));
        else { await field.fill(expected); await field.blur(); }
        await waitSavedName(expected);
        await page.evaluate(() => globalThis.releaseExport());
        assert.equal((await readDownload(await downloadPromise)).scenes[0].name, 'Before export', 'the download is the requested snapshot');
        await waitExported();
        assert.equal((await snapshot()).scenes[0].name, expected, 'export cannot overwrite a newer local snapshot');
        await page.reload();
        await field.waitFor();
        assert.equal(await field.inputValue(), expected);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale} ${width}: undo/redo, hover Escape, preview drafts, project isolation, IME/audio race, CRLF and export races`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
