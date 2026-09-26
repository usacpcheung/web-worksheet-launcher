// Isolated browser storage and read-only synthetic publication API.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { createStoredZip } from '../server/editor/zip-utils.js';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
if (process.env.VIEWER_SMOKE_SCREENSHOTS) await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const project = { meta: { title: 'Published story' }, scenes: [
  { id: 'scene-021', type: 'start', image: { name: 'cover.png', type: 'image/png', path: 'media/cover.png' }, dialogue: [{ text: 'Original dialogue' }], choices: [{ id: 'choice-017', label: 'Finish', nextSceneId: 'scene-022' }] },
  { id: 'scene-022', type: 'end', dialogue: [], choices: [] },
] };
const zip = Buffer.from(createStoredZip([
  { path: 'manifest.json', data: JSON.stringify({ format: 'roleplayscene-package', packageVersion: 1, assets: [] }) },
  { path: 'content/project.json', data: JSON.stringify(project) },
  { path: 'media/cover.png', data: png },
]));
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', e => errors.push(e.message));
      let release, artifactCalls = 0;
      const waitDownload = async () => {
        for (let attempt = 0; attempt < 500 && !release; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(release, `artifact request did not start: ${await page.locator('body').innerText()}`);
      };
      await context.route(url => url.pathname.startsWith('/api/'), async route => {
        const request = route.request();
        requests.push(request.method());
        if (new URL(request.url()).pathname.endsWith('/artifact')) {
          artifactCalls++;
          await new Promise(resolve => { release = resolve; });
          await route.fulfill({ contentType: 'application/zip', headers: { 'content-length': String(zip.length) }, body: zip });
        } else await route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [
          { roleplayscene_published_scene_id: '11111111-1111-4111-8111-111111111111', title: 'Published story', owner_sub: 'someone-else' },
        ] } } });
      });
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.goto(base + '/server/roleplayscene/index.html');
      assert.equal(await page.title(), 'RolePlayScene');
      const title = page.locator('[data-focus-key="project-title"]');
      await title.fill('Keep my current story');
      await title.blur();
      const browse = async () => {
        if (!await page.locator('#server-browse-published-btn').isVisible()) await page.locator('#toolbar-more-btn').click();
        await page.locator('#server-browse-published-btn').click();
        await page.locator('[data-published-edit-id]').waitFor();
      };
      for (const accept of [false, true]) {
        await browse();
        const button = page.locator('[data-published-edit-id]');
        const calls = artifactCalls;
        await button.click();
        await page.waitForFunction(() => document.querySelector('[data-published-edit-id]')?.getAttribute('aria-busy') === 'true');
        assert.equal(await button.isDisabled(), true);
        assert.equal(await page.locator('.published-browser-filters button').isDisabled(), true);
        assert.equal(await page.locator('.published-refresh-action').isDisabled(), true);
        assert.equal(await page.locator('.published-more-action').isDisabled(), true);
        assert.equal(await page.locator('#server-browse-published-btn').isDisabled(), true);
        assert.equal(await title.inputValue(), 'Keep my current story');
        await button.evaluate(el => el.click());
        await waitDownload();
        assert.equal(artifactCalls, calls + 1, 'duplicate clicks cannot download twice');
        release(); release = null;
        await page.locator('#import-confirm-overlay').waitFor({ state: 'visible' });
        assert.equal(await title.inputValue(), 'Keep my current story', 'download cannot replace before confirmation');
        await page.locator(accept ? '#import-confirm-accept' : '#import-confirm-cancel').click();
        await page.locator('#import-confirm-overlay').waitFor({ state: 'hidden' });
        if (!accept) assert.equal(await title.inputValue(), 'Keep my current story');
      }
      const copiedTitle = locale === 'en' ? 'Published story (copy)' : 'Published story（副本）';
      await page.waitForFunction(expected => document.querySelector('[data-focus-key="project-title"]')?.value === expected, copiedTitle);
      await page.waitForFunction(() => !document.querySelector('#new-story-btn').disabled);
      if (process.env.VIEWER_SMOKE_SCREENSHOTS) await page.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/rps-edit-copy-${locale}-${width}.png` });
      await title.fill('My new version');
      await title.blur();
      // Allow the normal autosave debounce, then verify the persisted edited copy.
      const persisted = () => page.evaluate(() => new Promise(resolve => {
        const req = indexedDB.open('roleplayscene');
        req.onsuccess = () => {
          const db = req.result, read = db.transaction('project').objectStore('project').get('snapshot');
          read.onsuccess = () => { db.close(); const value = read.result; resolve({ title: value?.meta?.title, scene: value?.scenes?.[0], imageBytes: value?.scenes?.[0]?.image?.blob?.size }); };
        };
      }));
      for (let attempt = 0; attempt < 100 && (await persisted()).title !== 'My new version'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const saved = await persisted();
      assert.equal(saved.title, 'My new version');
      assert.equal(saved.scene.id, 'scene-021');
      assert.equal(saved.scene.choices[0].nextSceneId, 'scene-022');
      assert.equal(saved.scene.dialogue[0].text, 'Original dialogue');
      assert.equal(saved.imageBytes, png.length);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('[data-focus-key="project-title"]')?.value === 'My new version');
      assert.equal(await title.inputValue(), 'My new version');
      // A direct-link player starts without local autosave. Copying from its
      // browser must reconnect persistence and clear the published launch URL.
      await page.goto(base + '/server/roleplayscene/index.html?publishedSceneId=11111111-1111-4111-8111-111111111111');
      await waitDownload();
      release(); release = null;
      await page.waitForFunction(() => !document.querySelector('#published-exit-btn').hidden);
      await browse();
      await page.locator('[data-published-edit-id]').click();
      await waitDownload();
      release(); release = null;
      await page.locator('#import-confirm-accept').click();
      await page.waitForFunction(() => !new URL(location.href).searchParams.has('publishedSceneId')
        && !document.querySelector('#new-story-btn').disabled);
      await title.fill('Direct link copy');
      await title.blur();
      for (let attempt = 0; attempt < 100 && (await persisted()).title !== 'Direct link copy'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal((await persisted()).title, 'Direct link copy');
      assert.ok(requests.every(method => method === 'GET'), 'opening/editing never writes to the publication API');
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale} ${width}: published copy, busy/duplicate guard, cancel, confirm, edit and reload`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
