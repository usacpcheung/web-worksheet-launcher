import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  const recoveryContext = await browser.newContext();
  const recoveryPage = await recoveryContext.newPage();
  await recoveryPage.goto(`${base}/server/viewer/index.html`);
  const races = await recoveryPage.evaluate(async () => {
    const { createStorageApi } = await import('/server/app/storage/indexeddb.js');
    const { withRecovery, writeRecovery, readRecovery } = await import('/server/app/storage/recovery-journal.js');
    const db = createStorageApi();
    const results = [];
    for (const [store, suffix] of [['localDrafts', 'LocalDraft'], ['localAttempts', 'LocalAttempt']]) {
      for (const action of ['save', 'delete', 'clear']) {
        const id = `recovery-race-${store}-${action}`;
        const record = (title, second) => ({ localId: id, title, metadata: { localId: id, origin: 'fixture', updatedAt: `2026-10-13T00:00:0${second}.000Z` } });
        const old = record('old', 1), pending = record('journal', 2), latest = record('latest', 2);
        await db[`put${suffix}`](old); writeRecovery(store, pending);
        let release, entered;
        const blocked = new Promise(resolve => { entered = resolve; });
        const api = withRecovery(store, {
          get: async key => { const snapshot = await db[`get${suffix}`](key); entered(); await new Promise(resolve => { release = resolve; }); return snapshot; },
          recover: db[`recover${suffix}`], put: db[`put${suffix}`],
        });
        const reading = api.get(id); await blocked;
        // Bypass the adapter to model another tab committing after the read snapshot.
        if (action === 'save') await db[`put${suffix}`](latest);
        else if (action === 'delete') await db[`delete${suffix}`](id);
        else await db[`clear${suffix}s`]();
        release(); const restored = await reading;
        results.push({ action, restored: restored?.title || null, persisted: (await db[`get${suffix}`](id))?.title || null, journal: readRecovery(store, id) });
      }
    }
    return results;
  });
  for (const result of races) {
    assert.equal(result.persisted, result.action === 'save' ? 'latest' : null);
    assert.equal(result.restored, result.persisted);
    assert.equal(result.journal, null);
  }
  await recoveryContext.close();
  console.log('PASS: atomic recovery preserves newer equal-timestamp saves and concurrent delete/clear in both stores');
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
    let uploadArrived, held, mode = 'upload';
    await context.route(url => url.pathname.startsWith('/api/'), route => {
      if (route.request().method() === 'POST' && route.request().url().includes('/upload')) {
        if (mode === 'refresh') return route.fulfill({ json: { ok: true, data: { uploaded_draft_id: 'saved', roleplayscene_uploaded_draft_id: 'saved' } } });
        held = route; uploadArrived?.(); return;
      }
      if (mode === 'refresh' && route.request().method() === 'GET' && new URL(route.request().url()).pathname.endsWith('/drafts')) {
        held = route; uploadArrived?.(); return;
      }
      return route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/server/editor/index.html`);
    await page.waitForFunction(() => window.editorSession);
    const draftId = await page.evaluate(async () => {
      const s = window.editorSession;
      s.state.draft.blocks = [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Question', format: 'plain_text' }, responseConfig: { inputType: 'text', maxLength: 200 } }];
      s.updateTitle('Saved title'); await s.saveNow(); return s.state.draft.localId;
    });
    // Force IndexedDB saves to remain unfinished so reload must use the synchronous journal.
    await page.evaluate(() => {
      const s = window.editorSession; s.storage.drafts.put = () => new Promise(() => {});
      s.updateTitle('Last second title');
    });
    await page.reload(); await page.waitForFunction(() => window.editorSession);
    assert.equal(await page.evaluate(async id => (await window.editorSession.storage.drafts.get(id)).title, draftId), 'Last second title');
    let arrived = new Promise(resolve => { uploadArrived = resolve; });
    await page.evaluate(() => { window.uploadResult = null; window.editorSession.uploadCurrentDraftToServer({ preflight: false }).then(result => { window.uploadResult = result; }); });
    await arrived;
    await page.locator('.editor-more-actions > summary').click();
    const editorCancel = page.locator('[data-upload-cancel="editor"]');
    assert.equal(await editorCancel.textContent(), locale === 'en' ? 'Cancel' : '取消');
    await editorCancel.click(); await page.waitForFunction(() => window.uploadResult);
    assert.equal(await page.evaluate(() => window.uploadResult.error.code), 'ABORTED');
    await editorCancel.waitFor({ state: 'hidden' });
    await held.abort().catch(() => {});

    mode = 'refresh';
    arrived = new Promise(resolve => { uploadArrived = resolve; });
    await page.evaluate(() => { window.uploadResult = null; window.editorSession.uploadCurrentDraftToServer({ preflight: false }).then(result => { window.uploadResult = result; }); });
    await arrived;
    await editorCancel.click(); await page.waitForFunction(() => window.uploadResult);
    assert.equal(await page.evaluate(() => window.uploadResult.ok), true);
    assert.equal(await page.evaluate(() => window.editorSession.state.lastUploadedDraft.uploaded_draft_id), 'saved');
    assert.equal(await page.evaluate(() => window.editorSession.state.isLoadingUploadedDrafts), false);
    await editorCancel.waitFor({ state: 'hidden' });
    await held.abort().catch(() => {}); mode = 'upload';

    await page.goto(`${base}/server/viewer/index.html?localDraftId=${draftId}`);
    await page.waitForFunction(() => window.viewerSession?.state.localAttemptId);
    const attemptId = await page.evaluate(async () => { const s = window.viewerSession; s.setAnswer('q1', 'Saved'); await s.autosave(); return s.state.localAttemptId; });
    await page.evaluate(() => { const s = window.viewerSession; s.storage.attempts.put = () => new Promise(() => {}); s.setAnswer('q1', 'Last second answer'); });
    await page.reload(); await page.waitForFunction(() => window.viewerSession);
    assert.equal(await page.evaluate(async id => (await window.viewerSession.storage.attempts.get(id)).answers.q1.value, attemptId), 'Last second answer');
    arrived = new Promise(resolve => { uploadArrived = resolve; });
    await page.evaluate(() => { window.uploadResult = null; window.viewerSession.uploadCurrentAttemptPackage().then(result => { window.uploadResult = result; }); });
    await arrived;
    const viewerCancel = page.locator('[data-upload-cancel="viewer"]');
    assert.equal(await viewerCancel.getAttribute('aria-label'), locale === 'en' ? 'Cancel' : '取消');
    await viewerCancel.click(); await page.waitForFunction(() => window.uploadResult);
    assert.equal(await page.evaluate(() => window.uploadResult.error.code), 'ABORTED');
    await viewerCancel.waitFor({ state: 'hidden' });
    await held.abort().catch(() => {});

    await page.goto(`${base}/server/roleplayscene/index.html`);
    const save = page.locator('#server-save-btn');
    await save.waitFor({ state: 'attached' });
    if (!await save.isVisible()) await page.locator('#toolbar-more-btn').click();
    const saveLabel = await save.textContent();
    arrived = new Promise(resolve => { uploadArrived = resolve; });
    await save.click(); await arrived;
    if (!await save.isVisible()) await page.locator('#toolbar-more-btn').click();
    assert.notEqual(await save.textContent(), saveLabel);
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await page.waitForFunction(() => document.querySelector('#server-save-btn').getAttribute('aria-busy') === 'false');
    assert.equal(await save.textContent(), saveLabel);
    await held.abort().catch(() => {});
    mode = 'refresh';
    if (!await save.isVisible()) await page.locator('#toolbar-more-btn').click();
    arrived = new Promise(resolve => { uploadArrived = resolve; });
    await save.click(); await arrived;
    if (!await save.isVisible()) await page.locator('#toolbar-more-btn').click();
    await save.click();
    await page.waitForFunction(() => document.querySelector('#server-save-btn').getAttribute('aria-busy') === 'false');
    assert.equal(await save.textContent(), saveLabel);
    assert.equal(await page.locator('#server-manage-btn').isEnabled(), true);
    await held.abort().catch(() => {});
    assert.deepEqual(errors, []);
    console.log(`PASS: forced pending-write reload recovery and upload/refresh Cancel controls (${locale}, ${width}px)`);
    await context.close();
  }
} finally { await browser.close(); }
