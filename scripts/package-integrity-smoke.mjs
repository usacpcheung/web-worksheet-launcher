import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) {
    const page = await browser.newPage();
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { items: [] } } }));
    await page.goto(base + '/server/viewer/');
    const result = await page.evaluate(async locale => {
      const { setLocale } = await import('/server/app/i18n/index.js'); setLocale(locale);
      const { ViewerAttemptSession } = await import('/server/viewer/main.js');
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      const { createWorksheetPackageFromDraft, parseWorksheetPackage, rewriteWorksheetPackageTitle } = await import('/server/editor/worksheet-package.js');
      const { createStoredZip, parseStoredZip, decodeUtf8 } = await import('/server/editor/zip-utils.js');
      const s = new ViewerAttemptSession(viewerStorage);
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const draft = { title: 'Integrity 圖片', blocks: [{ blockId: 'q', kind: 'question', position: 0, prompt: { text: '## Choose 圖片', format: 'limited-markdown-v1' }, responseConfig: { inputType: 'multiple_choice', options: [{ id: 'o', value: 'o', label: '', imageDescription: 'Diagram 圖', mediaRefs: [{ usage: 'option_image', assetId: 'img' }] }] } }], assets: [{ assetId: 'img', path: 'media/img.png', kind: 'image', usage: 'option_image', mimeType: 'image/png' }] };
      const pkg = createWorksheetPackageFromDraft(draft, new Map([['img', { binary: png }]]));
      const renamed = parseWorksheetPackage(rewriteWorksheetPackageTitle(pkg.bytes, 'Renamed'));
      await s.startImportedWorksheetFromPackageModel(renamed);
      s.state.answers = { q: { value: 'o' } };
      const exported = await s.buildUploadedAttemptPackage();
      await s.importAttemptPackageFromFile(exported.bytes);
      clearTimeout(s.autosaveTimer);
      const priorId = s.state.viewerPayload.blocks[0].responseConfig.options[0].mediaRefs[0].assetId;
      const priorAttempt = s.state.localAttemptId;
      const priorAsset = await viewerStorage.localAssets.get(priorId);
      const put = viewerStorage.attempts.put;
      viewerStorage.attempts.put = async record => { await put(record); throw Error('Simulated failed acknowledgment'); };
      let rejected = false;
      try { await s.importAttemptPackageFromFile(exported.bytes); } catch { rejected = true; }
      finally { viewerStorage.attempts.put = put; }
      const stillThere = await viewerStorage.localAssets.get(priorId);
      const output = { worksheetVersion: pkg.manifest.packageVersion, attemptVersion: exported.manifest.packageVersion,
        imageBytes: priorAsset.binary.length, answer: s.state.answers.q.value, failedImportRejected: rejected,
        previousAttemptPreserved: s.state.localAttemptId === priorAttempt,
        previousImagePreserved: JSON.stringify(Array.from(stillThere.binary)) === JSON.stringify(Array.from(png)),
        invalidImports: [] };
      for (const kind of ['outside-media', 'duplicate-id', 'empty']) {
        const files = parseStoredZip(exported.bytes), manifest = JSON.parse(decodeUtf8(files.get('manifest.json')));
        const image = manifest.assets[0];
        if (kind === 'outside-media') { files.set('pictures/img.png', files.get(image.path)); files.delete(image.path); image.path = 'pictures/img.png'; }
        if (kind === 'duplicate-id') { manifest.assets.push({ ...image, path: 'media/other.png' }); files.set('media/other.png', png); }
        if (kind === 'empty') { files.set(image.path, new Uint8Array()); delete image.byteLength; delete image.crc32; }
        files.set('manifest.json', JSON.stringify(manifest));
        try { await s.importAttemptPackageFromFile(createStoredZip([...files].map(([path, data]) => ({ path, data })))); output.invalidImports.push(false); }
        catch { output.invalidImports.push(true); }
      }
      await viewerStorage.localAssets.remove(priorId);
      let requests = 0; s.apiClient.uploadAttemptPackage = async () => { requests++; return { ok: true }; };
      const upload = await s.uploadCurrentAttemptPackage();
      const download = await s.exportCurrentAttemptPackage();
      output.missing = { requests, uploadCode: upload.error?.code, downloadOk: download.ok,
        answer: s.state.answers.q.value, message: s.state.utilityMessage };
      clearTimeout(s.autosaveTimer);
      return output;
    }, locale);
    assert.equal(result.worksheetVersion, 4); assert.equal(result.attemptVersion, 3);
    assert.equal(result.imageBytes, 68); assert.equal(result.answer, 'o');
    assert.equal(result.failedImportRejected, true); assert.equal(result.previousAttemptPreserved, true); assert.equal(result.previousImagePreserved, true);
    assert.deepEqual(result.invalidImports, [true, true, true]);
    assert.equal(result.missing.requests, 0); assert.equal(result.missing.uploadCode, 'MISSING_PACKAGE_MEDIA'); assert.equal(result.missing.downloadOk, false); assert.equal(result.missing.answer, 'o');
    assert.match(result.missing.message, locale === 'en' ? /media is missing/ : /媒體遺失/);
    await page.close();
  }
  console.log('Package integrity: bilingual roundtrip, isolated rollback, malformed imports and missing-media export/upload guards passed');
} finally { await browser.close(); }
