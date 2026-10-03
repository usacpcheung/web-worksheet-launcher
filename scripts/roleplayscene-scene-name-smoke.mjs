// Real editor, isolated browser storage and synthetic server responses only.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createStoredZip } from '../server/editor/zip-utils.js';
import { unzipSync } from '../server/roleplayscene/scripts/vendor/fflate.module.js';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      let uploaded, oldDraftZip;
      await context.route(url => url.pathname.startsWith('/api/'), async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/artifact') && oldDraftZip) {
          await route.fulfill({ contentType: 'application/zip', body: oldDraftZip });
          return;
        }
        if (route.request().method() === 'POST') uploaded = route.request().postDataBuffer();
        await route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: path.endsWith('/roleplayscene/drafts') ? [{ roleplayscene_uploaded_draft_id: '11111111-1111-4111-8111-111111111111', title: 'Old uploaded draft' }] : [], uploadedDraftId: 'fixture' } } });
      });
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.goto(base + '/server/roleplayscene/index.html');
      assert.equal(await page.title(), 'RolePlayScene');
      const longId = 'Legacy scene "茶" ' + '很長的場景名稱'.repeat(18);
      const raw = { meta: { title: 'Scene names' }, scenes: [
        { id: 'scene01', type: 'start', dialogue: [{ text: 'Hello' }], choices: [{ id: 'c1', label: 'Continue', nextSceneId: longId }] },
        { id: longId, type: 'intermediate', dialogue: [], choices: [], autoNextSceneId: 'ending' },
        { id: 'ending', type: 'end', dialogue: [], choices: [] },
      ] };
      const importJson = async data => {
        await page.locator('#file-input').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
        await page.locator('#import-confirm-accept').click();
        await page.locator('#import-confirm-overlay').waitFor({ state: 'hidden' });
      };
      // Restore a pre-feature local snapshot before exercising JSON import.
      await page.locator('[data-focus-key="project-title"]').waitFor();
      await page.evaluate(raw => new Promise((resolve, reject) => {
        const request = indexedDB.open('roleplayscene');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('project', 'readwrite');
          tx.objectStore('project').put(raw, 'snapshot');
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }), raw);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('[data-focus-key="project-title"]')?.value === 'Scene names');
      assert.equal(await page.locator('[data-focus-key^="scene-name-"]').inputValue(), 'scene01');
      await importJson(raw);
      const field = page.getByLabel(locale === 'en' ? 'Scene name' : '場景名稱', { exact: true });
      const idField = page.getByLabel(locale === 'en' ? 'Scene ID' : '場景 ID', { exact: true });
      const selectScene = async id => {
        const items = page.locator('.graph-nodes > g');
        const index = await items.evaluateAll((nodes, id) => nodes.findIndex(node => node.dataset.sceneId === id), id);
        await items.nth(index).click();
      };
      assert.equal(await field.inputValue(), 'scene01');
      assert.equal(await idField.getAttribute('readonly'), '');
      await selectScene(longId);
      assert.equal(await field.inputValue(), longId);
      assert.equal(await field.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, 'full inherited name wraps without an internal scroll');
      assert.equal(await idField.inputValue(), longId);
      await field.fill('Shared name');
      await field.blur();
      assert.equal(await page.locator('[data-focus-key^="auto-next-"]').inputValue(), 'ending');
      await selectScene('ending');
      await field.fill('Shared name');
      await field.blur();
      await selectScene('scene01');
      const destination = page.locator('[data-focus-key^="choice-target-"]');
      assert.equal(await destination.inputValue(), longId, 'rename does not change destination');
      const sharedOptions = await destination.locator('option').allTextContents();
      assert(sharedOptions.includes('Shared name · ' + longId));
      assert(sharedOptions.includes('Shared name · ending'));
      assert.equal(await page.locator('.rps-destination-detail').first().textContent(), 'Shared name · ' + longId);

      await field.fill('<b>Tea</b>');
      assert.equal(await page.locator('.graph-node-title').first().textContent(), '<b>Tea</b>');
      assert.equal(await page.locator('.graph-nodes b, #right-pane b').count(), 0, 'names are literal text');
      await field.fill('');
      await field.blur();
      assert.equal(await field.inputValue(), 'scene01', 'blank name commits to its ID');
      await field.fill('');
      await field.pressSequentially('Tea with friends');
      assert.equal(await field.inputValue(), 'Tea with friends');
      assert.equal(await field.evaluate(el => el === document.activeElement), true, 'typing retains focus');
      assert.equal(await field.evaluate(el => el.selectionStart), 16);
      await field.evaluate(el => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = '茶館相聚';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      });
      assert.equal(await page.locator('.graph-node-title').first().textContent(), 'Tea with friends', 'composition is not committed prematurely');
      await field.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      assert.equal(await page.locator('.graph-node-title').first().textContent(), '茶館相聚');

      await field.fill('🍵'.repeat(81));
      assert.equal(await field.getAttribute('aria-invalid'), 'true');
      assert.equal(await page.locator('.rps-scene-name-error').isVisible(), true);
      assert.equal(await page.locator('.graph-node-title').first().textContent(), '茶館相聚', 'invalid draft does not replace saved name');
      const fullName = locale === 'en' ? 'Ordering drinks at the café with friends before the restaurant closes' : '和朋友在餐廳打烊之前點飲品，並且練習有禮貌地詢問店員各種飲品的價格與材料';
      await field.fill(fullName);
      await field.blur();
      assert.equal(await field.getAttribute('aria-invalid'), 'false', JSON.stringify({ value: await field.inputValue(), length: Array.from(fullName).length, error: await page.locator('.rps-scene-name-error').textContent() }));
      const mapTitle = page.locator('.graph-node-title').first();
      assert((await mapTitle.textContent()).endsWith('…'));
      assert.equal(await mapTitle.evaluate(el => el.getComputedTextLength() <= 180), true);
      const firstNode = page.locator('.graph-nodes > g').first();
      await firstNode.focus();
      assert.equal(await page.locator('.graph-scene-tooltip').textContent(), fullName + ' · scene01');
      assert.equal(await page.locator('.graph-scene-tooltip').isVisible(), true);
      await firstNode.press('Escape');
      assert.equal(await page.locator('.graph-scene-tooltip').isVisible(), false);
      await page.mouse.move(0, 0);
      await firstNode.hover();
      assert.equal(await page.locator('.graph-scene-tooltip').isVisible(), true);
      await field.click();
      assert.equal(await field.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true);
      await field.press('ControlOrMeta+A');
      await field.press('ControlOrMeta+C');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fullName);
      await idField.click();
      await idField.press('ControlOrMeta+A');
      await idField.press('ControlOrMeta+C');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'scene01');
      assert.equal(await page.locator('#right-pane').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'long destination/ID does not widen inspector');
      if (shots) {
        await field.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shots}/scene-name-${locale}-${width}.png` });
      }
      const persisted = () => page.evaluate(() => new Promise(resolve => {
        const request = indexedDB.open('roleplayscene');
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction('project').objectStore('project').get('snapshot');
          read.onsuccess = () => { db.close(); resolve(read.result); };
        };
      }));
      for (let i = 0; i < 100 && (await persisted())?.scenes[0].name !== fullName; i++) await new Promise(resolve => setTimeout(resolve, 30));
      const saved = await persisted();
      assert.equal(saved.scenes[0].name, fullName);
      assert.equal(saved.scenes[0].choices[0].nextSceneId, longId);
      assert.equal(saved.scenes[1].autoNextSceneId, 'ending');
      await page.reload();
      await field.waitFor();
      assert.equal(await field.inputValue(), fullName);
      const downloadPromise = page.waitForEvent('download');
      if (!await page.locator('#export-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
      await page.locator('#export-btn').click();
      const download = await downloadPromise;
      const entries = unzipSync(new Uint8Array(await readFile(await download.path())));
      const exported = JSON.parse(new TextDecoder().decode(entries['content/project.json']));
      assert.deepEqual(exported.scenes.map(s => [s.id, s.name]), saved.scenes.map(s => [s.id, s.name]));
      // Save to server uses the same upgraded package path.
      if (!await page.locator('#server-save-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
      const uploadResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/roleplayscene/drafts/upload'));
      await page.locator('#server-save-btn').click();
      await uploadResponse;
      await page.waitForFunction(() => !document.querySelector('#server-save-btn').disabled);
      assert(uploaded, 'server save posted the new package');
      const uploadEntries = unzipSync(new Uint8Array(uploaded));
      assert.equal(JSON.parse(new TextDecoder().decode(uploadEntries['content/project.json'])).scenes[0].name, fullName);

      // Opening an old server draft also upgrades names when saved again.
      raw.scenes[0].image = { name: 'cover.png', type: 'image/png', path: 'media/cover.png' };
      const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
      oldDraftZip = Buffer.from(createStoredZip([
        { path: 'media/cover.png', data: imageBytes },
        { path: 'manifest.json', data: JSON.stringify({ format: 'roleplayscene-package', packageVersion: 1 }) },
        { path: 'content/project.json', data: JSON.stringify(raw) },
      ]));
      if (!await page.locator('#server-manage-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
      await page.locator('#server-manage-btn').click();
      await page.locator('[data-draft-action="open"]').click();
      await page.locator('#import-confirm-accept').click();
      await page.waitForFunction(() => !document.querySelector('#server-manage-btn').disabled);
      assert.equal(await field.inputValue(), 'scene01');
      uploaded = null;
      const resaved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/roleplayscene/drafts/upload'));
      if (!await page.locator('#server-save-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
      await page.locator('#server-save-btn').click();
      await resaved;
      const upgraded = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(uploaded))['content/project.json']));
      assert.deepEqual(upgraded.scenes.map(s => s.name), raw.scenes.map(s => s.id));
      await field.fill(fullName);
      await field.blur();
      assert.equal(await page.locator('.graph-node-thumb').count(), 1);
      assert.equal(await page.locator('.graph-node-title').first().evaluate(el => el.getComputedTextLength() <= 110), true, 'label fits beside its thumbnail');

      // A rejected import must not enter replacement confirmation or disturb the draft.
      raw.scenes[1].id = 'scene01';
      await page.locator('#file-input').setInputFiles({ name: 'duplicate.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(raw)) });
      await page.waitForFunction(() => !document.querySelector('#file-input').value);
      assert.equal(await page.locator('#import-confirm-overlay').isVisible(), false);
      assert.equal(await field.inputValue(), fullName);
      // Shared shape validation reports the handled duplicate-ID rejection.
      // No unrelated console/runtime errors may accompany it.
      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.match(errors[0], /^ProjectImportError: Project data is invalid\n/, JSON.stringify(errors));
      console.log(`PASS ${locale} ${width}: names, IME, legacy IDs, duplicate labels, wrapping, tooltip, copy, links, reload/export/upload, safe rejection`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
