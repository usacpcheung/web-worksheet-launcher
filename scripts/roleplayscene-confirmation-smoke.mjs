// Real main.js handlers and IndexedDB, isolated contexts, synthetic local files.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createStoredZip } from '../server/editor/zip-utils.js';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function fixture(title) {
  return { name: `${title}.zip`, mimeType: 'application/zip', buffer: Buffer.from(createStoredZip([
    { path: 'manifest.json', data: JSON.stringify({ format: 'roleplayscene-package', packageVersion: 1, assets: [] }) },
    { path: 'content/project.json', data: JSON.stringify({ meta: { title }, scenes: [
      { id: 'scene-021', type: 'start', image: { name: 'cover.png', type: 'image/png', path: 'media/cover.png' },
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
      const errors = [], consoleErrors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
      await page.addInitScript(locale => {
        localStorage.setItem('worksheetLauncher.locale', locale);
        window.fixtureUrls = { created: [], revoked: [] };
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => { const url = create(blob); window.fixtureUrls.created.push(url); return url; };
        URL.revokeObjectURL = url => { window.fixtureUrls.revoked.push(url); revoke(url); };
        window.readFixtureSnapshot = () => new Promise((resolve, reject) => {
          const request = indexedDB.open('roleplayscene');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('project', 'readonly');
            const read = tx.objectStore('project').get('snapshot');
            read.onerror = () => { db.close(); reject(read.error); };
            read.onsuccess = () => { db.close(); resolve(read.result); };
          };
        });
      }, locale);
      await page.goto(`${base}/server/roleplayscene/index.html`);
      assert.equal(await page.title(), 'RolePlayScene');
      const title = page.locator('[data-focus-key="project-title"]');
      await title.waitFor();
      assert.equal(await page.locator('#locale-select').inputValue(), locale);
      const overlay = page.locator('#import-confirm-overlay');
      const input = page.locator('#file-input');
      const persisted = () => page.evaluate(() => window.readFixtureSnapshot());
      const waitPersisted = expected => page.waitForFunction(async expected =>
        (await window.readFixtureSnapshot())?.meta?.title === expected, expected);
      const finishImport = () => page.waitForFunction(() => document.querySelector('#file-input').value === '');
      const openNewStory = async () => {
        if (!await page.locator('#new-story-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
        await page.locator('#new-story-btn').click();
        await overlay.waitFor({ state: 'visible' });
      };

      await input.setInputFiles(fixture('Original'));
      await page.locator('#import-confirm-accept').click();
      await finishImport();
      await waitPersisted('Original');
      assert.equal(await title.inputValue(), 'Original');
      const baseline = await persisted();
      const activeUrls = await page.evaluate(() => [...window.fixtureUrls.created]);
      assert.ok(activeUrls.length > 0);

      for (const cancel of ['button', 'escape']) {
        const before = await page.evaluate(() => window.fixtureUrls.created.length);
        await input.setInputFiles(fixture('Replacement'));
        await overlay.waitFor({ state: 'visible' });
        assert.equal(await title.inputValue(), 'Original', 'no replacement before confirmation');
        assert.deepEqual(await persisted(), baseline, 'no persistent replacement before confirmation');
        const candidates = await page.evaluate(before => window.fixtureUrls.created.slice(before), before);
        assert.ok(candidates.length > 0);
        await page.waitForFunction(() => document.activeElement === document.querySelector('#import-confirm-accept'));
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#import-confirm-cancel').evaluate(el => el === document.activeElement), true);
        if (shots) await page.screenshot({ path: `${shots}/rps-import-${cancel}-${locale}-${width}.png` });
        if (cancel === 'escape') await page.keyboard.press('Escape');
        else await page.locator('#import-confirm-cancel').click();
        await finishImport();
        assert.equal(await overlay.isHidden(), true);
        assert.equal(await title.inputValue(), 'Original');
        assert.deepEqual(await persisted(), baseline);
        const revoked = await page.evaluate(() => window.fixtureUrls.revoked);
        assert.ok(candidates.every(url => revoked.includes(url)), 'cancel releases candidate media');
        assert.ok(activeUrls.every(url => !revoked.includes(url)), 'cancel retains active media');
      }

      const invalidLabel = await page.evaluate(async () => (await import('/server/roleplayscene/scripts/i18n.js')).translate('messages.importInvalidJson'));
      await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
      await page.getByText(invalidLabel, { exact: true }).waitFor();
      await finishImport();
      assert.equal(await overlay.isHidden(), true);
      assert.equal(await title.inputValue(), 'Original');
      assert.deepEqual(await persisted(), baseline);
      assert.equal(consoleErrors.length, 1, 'only the deliberately invalid import should log an error');
      assert.match(consoleErrors[0], /Project JSON is unreadable/);
      consoleErrors.length = 0;

      await input.setInputFiles(fixture('Replacement'));
      await page.locator('#import-confirm-accept').click();
      await finishImport();
      await waitPersisted('Replacement');
      assert.equal(await title.inputValue(), 'Replacement');
      assert.ok(await page.evaluate(urls => urls.every(url => window.fixtureUrls.revoked.includes(url)), activeUrls));
      await page.reload();
      await title.waitFor();
      assert.equal(await title.inputValue(), 'Replacement', 'confirmed replacement survives reload');
      const replacement = await persisted();
      const replacementUrls = await page.evaluate(() => [...window.fixtureUrls.created]);
      assert.ok(replacementUrls.length > 0, 'reload restores persisted media');

      for (const cancel of ['button', 'escape']) {
        await openNewStory();
        assert.equal(await title.inputValue(), 'Replacement');
        assert.deepEqual(await persisted(), replacement);
        assert.ok(await page.evaluate(urls => urls.every(url => !window.fixtureUrls.revoked.includes(url)), replacementUrls),
          'new-story cancellation retains active media');
        if (cancel === 'escape') await page.keyboard.press('Escape');
        else await page.locator('#import-confirm-cancel').click();
        await overlay.waitFor({ state: 'hidden' });
        assert.equal(await title.inputValue(), 'Replacement');
        assert.deepEqual(await persisted(), replacement);
      }
      await openNewStory();
      if (shots) await page.screenshot({ path: `${shots}/rps-new-story-${locale}-${width}.png` });
      await page.locator('#import-confirm-accept').click();
      await page.waitForFunction(async () => (await window.readFixtureSnapshot())?.scenes?.[0]?.id === 'scene-001');
      const fresh = await persisted();
      assert.notEqual(fresh.meta.title, 'Replacement');
      assert.equal(fresh.scenes.length, 1);
      assert.ok(await page.evaluate(urls => urls.every(url => window.fixtureUrls.revoked.includes(url)), replacementUrls),
        'confirmed new story releases old media');
      assert.equal(await page.locator('#mode-edit').getAttribute('class').then(value => value.includes('active')), true);
      await page.reload();
      await title.waitFor();
      assert.equal(await title.inputValue(), fresh.meta.title);
      assert.deepEqual(await persisted(), fresh);
      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors, []);
      console.log(`PASS ${locale} ${width}: import/new-story cancel/confirm, keyboard, invalid import/retry, media cleanup, IndexedDB/reload`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
