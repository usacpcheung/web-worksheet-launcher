import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch();
try {
  for (const change of ['rerender', 'delete', 'type', 'draft']) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { items: [] } } }));
    await page.goto(base + '/server/editor/');
    await page.waitForFunction(() => window.editorSession);
    await page.evaluate(() => {
      const s = window.editorSession; s.state.draft.blocks = []; s.createBlock('question');
      const id = s.state.selectedBlockId; s.updateQuestionInputType(id, 'multiple_choice');
      s.updateQuestionOptionAtIndex(id, 0, 'Original');
      window.targetId = id; window.oldRow = document.querySelector('.option-row');
      const create = s.createLocalAssetRecord.bind(s);
      s.createLocalAssetRecord = async (...args) => {
        await new Promise(resolve => { window.releaseRead = resolve; });
        const asset = await create(...args); window.createdAsset = asset.assetId; return asset;
      };
      const attach = s.attachOptionImage.bind(s);
      s.attachOptionImage = async (...args) => { const result = await attach(...args); window.attachResult = result; return result; };
    });
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.editor-option-image-button').first().click();
    await (await chooser).setFiles({ name: 'image.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => window.releaseRead);
    await page.evaluate(change => {
      const s = window.editorSession, id = window.targetId;
      if (change === 'rerender') s.updateQuestionOptionAtIndex(id, 1, 'Added during read');
      if (change === 'delete') s.removeQuestionOption(id, 0);
      if (change === 'type') s.updateQuestionInputType(id, 'text');
      if (change === 'draft') { s._audioDraftGeneration += 1; s.state.draft.localId += '-new'; }
      window.releaseRead();
    }, change);
    await page.waitForFunction(() => window.attachResult);
    const result = await page.evaluate(async () => ({ result: window.attachResult,
      detached: !window.oldRow.isConnected,
      binary: Boolean(await window.editorSession.storage.localAssets.get(window.createdAsset)),
      assets: window.editorSession.state.draft.assets.length,
    }));
    if (change === 'rerender') {
      assert(result.detached); assert(result.result.ok); assert(result.binary); assert.equal(result.assets, 1);
      // An old removal confirmation must not remove a newly replaced image.
      await page.locator('.editor-option-image-attachment .media-action-btn').nth(2).click();
      await page.locator('.confirm-modal').waitFor();
      const replacement = await page.evaluate(async bytes => {
        const s = window.editorSession, id = window.targetId;
        // Release the test's read gate immediately for subsequent attachments.
        const pending = s.attachOptionImage(id, s.findBlock(id).responseConfig.options[0].id,
          new File([new Uint8Array(bytes)], 'new.png', { type: 'image/png' }), { confirmReplace: true });
        window.releaseRead(); return await pending;
      }, [...png]);
      assert(replacement.ok);
      await page.locator('.confirm-modal__actions button').last().click();
      await page.locator('.confirm-modal').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.editorSession.findBlock(window.targetId).responseConfig.options[0].mediaRefs.find(r => r.usage === 'option_image')?.assetId), replacement.assetId);
    } else {
      assert.equal(result.result.reason, 'stale-target'); assert.equal(result.binary, false); assert.equal(result.assets, 0);
    }
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('Image attachment survives rerenders, rejects deleted/type-changed/draft-changed targets, cleans stale files and guards removal confirmations.');
} finally { await browser.close(); }
