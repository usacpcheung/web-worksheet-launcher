import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(base + '/server/editor/');
  await page.waitForFunction(() => window.editorSession);
  await page.evaluate(() => window.editorSession.createBlock('question'));
  const actions = page.locator('.media-row-list--flat .media-row').first().locator('.media-action-btn');
  const chooser = page.waitForEvent('filechooser');
  await actions.first().click();
  await (await chooser).setFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
  });

  const view = actions.nth(1);
  await view.click({ trial: true });
  // Exercise persisted records like those restored from older worksheet packages.
  const id = await page.evaluate(async () => {
    const session = window.editorSession;
    const id = session.state.draft.assets.at(-1).assetId;
    const record = await session.storage.localAssets.get(id);
    delete record.metadata.mimeType;
    await session.storage.localAssets.put(record);
    return id;
  });
  const opened = page.waitForEvent('popup');
  await view.click();
  const preview = await opened;
  await preview.waitForFunction(() => document.images[0]?.naturalWidth === 1);
  assert.equal(preview.url(), 'about:blank');
  assert.equal(await preview.evaluate(() => window.opener === null), true);
  await preview.close();

  await page.evaluate(async id => {
    const store = window.editorSession.storage.localAssets;
    const record = await store.get(id);
    record.binary = new TextEncoder().encode('This is not an image.');
    record.metadata.mimeType = 'image/png';
    await store.put(record);
  }, id);
  await view.click();
  await page.waitForFunction(() => Boolean(window.editorSession.state.mediaFeedback));
  assert.equal(await view.isEnabled(), true);
  assert.equal(await actions.nth(2).isEnabled(), true);
} finally {
  await browser.close();
}
