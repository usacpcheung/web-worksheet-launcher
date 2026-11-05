// Isolated microphone/provider fixtures; exercise the real viewer form and storage.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      let failRewrite = false, transcriptions = 0;
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/session')) return route.fulfill({ json: { ok: true, data: { user: { sub: 'selection-fixture' } } } });
        if (path.endsWith('/transcriptions')) { transcriptions++; return route.fulfill({ json: { ok: true, result: 'red' } }); }
        if (path.endsWith('/rewrite')) return route.fulfill({ json: failRewrite ? { ok: false, error: { code: 'UPSTREAM_FAILED' } } : { ok: true, result: 'red' } });
        return route.fulfill({ json: { ok: true, data: { items: [] } } });
      });
      await page.addInitScript(locale => {
        localStorage.setItem('worksheetLauncher.locale', locale);
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
        window.MediaRecorder = class {
          static isTypeSupported() { return true; }
          constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
          start() { this.state = 'recording'; }
          stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['fixture'], { type: 'audio/webm' }) }); this.onstop?.(); }); }
        };
      }, locale);
      await page.goto(`${base}/server/viewer/`);
      await page.evaluate(async () => {
        const { viewerStorage } = await import('/server/viewer/storage/index.js'); const now = new Date().toISOString();
        await viewerStorage.attempts.put({ localId: 'selection', localAttemptId: 'selection', status: 'in_progress', startedAt: now,
          viewerPayload: { worksheetId: 'w', snapshotId: 's', snapshotVersion: 1, title: 'Voice selection 選取文字', blocks: [{ blockId: 'q', kind: 'question', prompt: { text: 'Describe the fruit. 描述水果。' }, responseConfig: { inputType: 'text', maxLength: 18 } }] },
          answers: { q: { value: 'I like blue apples' } }, metadata: { localId: 'selection', origin: 'local_source', updatedAt: now } });
      });
      await page.goto(`${base}/server/viewer/?localAttemptId=selection`);
      const field = page.locator('.viewer-answer-area > textarea:not(.question-card__review-status)');
      const add = page.locator('.question-card__voice-btn');
      const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
      const select = async (start, end, direction = 'forward') => {
        await field.focus(); await field.evaluate((el, range) => { el.setSelectionRange(...range); el.dispatchEvent(new Event('select')); }, [start, end, direction]);
      };
      const record = async () => {
        await add.click(); await page.waitForFunction(() => viewerSession.voice.active?.state === 'recording');
        await page.getByRole('button', { name: await label('viewer.voice.stop'), exact: true }).click();
        await page.waitForFunction(() => !viewerSession.voice.active);
      };
      await select(7, 11, 'backward');
      assert.equal(await page.locator('.viewer-voice-hint').innerText(), await label('viewer.voice.replaceSelection'));
      if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/selection-${locale}-${width}.png` }); }
      await record(); assert.equal(await field.inputValue(), 'I like red apples');
      await page.locator('.question-card__undo-btn').click(); assert.equal(await field.inputValue(), 'I like blue apples');
      // At the answer limit: append is disabled, replacement is still available.
      await field.fill('x'.repeat(18)); await select(18, 18); assert.equal(await add.isDisabled(), true);
      await select(0, 18); assert.equal(await add.isEnabled(), true);
      await add.click(); await page.waitForFunction(() => viewerSession.voice.active?.state === 'recording');
      assert.equal(await field.inputValue(), 'x'.repeat(18));
      await page.getByRole('button', { name: await label('viewer.voice.cancel'), exact: true }).click();
      await page.waitForFunction(() => !viewerSession.voice.active);
      assert.equal(await field.inputValue(), 'x'.repeat(18));
      await page.getByRole('button', { name: await label('viewer.voice.discard'), exact: true }).click();
      await select(0, 18); await record(); assert.equal(await field.inputValue(), 'red');
      await page.locator('.question-card__undo-btn').click(); assert.equal(await field.inputValue(), 'x'.repeat(18));
      // Recovery keeps the original selection through reload and retries only rewrite.
      await field.fill('I like blue apples'); await select(7, 11); failRewrite = true;
      await record(); assert.equal(await field.inputValue(), 'I like blue apples');
      await page.evaluate(() => viewerSession.autosave());
      await page.reload();
      await page.locator('.viewer-voice-recovery').waitFor();
      assert.equal(await page.evaluate(() => viewerSession.state.voiceRecovery.q.replaceStart), 7);
      const before = transcriptions; failRewrite = false;
      await page.getByRole('button', { name: await label('viewer.voice.retryRewrite'), exact: true }).click();
      await page.waitForFunction(() => !viewerSession.voice.active && !viewerSession.state.voiceRecovery.q);
      assert.equal(await field.inputValue(), 'I like red apples'); assert.equal(transcriptions, before);
      assert.deepEqual(errors, []);
      console.log(`PASS selected replacement, limit, Undo, cancel and recovery ${locale}/${width}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
