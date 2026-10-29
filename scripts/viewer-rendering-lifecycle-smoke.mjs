// Isolated local attempts; microphone, audio playback and API responses are synthetic.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const screenshots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: {
      ok: true, data: { user: { sub: 'fixture', name: 'Test learner' }, items: [] }, result: 'Synthetic result',
    } }));
    await page.addInitScript(() => {
      window.recordingStarts = 0;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: async () => {
          if (window.holdPermission) await new Promise(resolve => { window.releasePermission = resolve; });
          return { getTracks: () => [{ stop() {} }] };
        },
      } });
      window.MediaRecorder = class {
        static isTypeSupported() { return true; }
        constructor() { this.state = 'inactive';this.mimeType = 'audio/webm'; }
        start() { this.state = 'recording';window.recordingStarts++; }
        stop() { this.state = 'inactive';queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob(['synthetic audio'], { type: 'audio/webm' }) });this.onstop?.();
        }); }
      };
    });
    await page.goto(base + '/server/viewer/index.html');
    await page.evaluate(async locale => {
      localStorage.setItem('worksheetLauncher.locale', locale);
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      const now = new Date().toISOString();
      const question = (id, type, config = {}) => ({ blockId: id, kind: 'question',
        prompt: { text: 'Question ' + id }, responseConfig: { inputType: type, ...config } });
      const blocks = [
        { blockId: 'intro', kind: 'content', content: { text: 'Reading before the questions.' } },
        question('text', 'text', { maxLength: 200 }),
        question('number', 'number'), question('boolean', 'boolean'),
        question('choice', 'multiple_choice', { shuffleOptions: true, selectionMode: 'single',
          options: ['A', 'B', 'C'].map(value => ({ id: value, value, label: 'Option ' + value })) }),
        { blockId: 'closing', kind: 'content', content: { text: 'Reading after the questions.' } },
      ].map((block, position) => ({ ...block, position }));
      await viewerStorage.attempts.put({ localId: 'rendering-fixture', localAttemptId: 'rendering-fixture',
        status: 'in_progress', startedAt: now, lastActiveBlockId: 'text', lastActiveIndex: 1,
        viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', snapshotVersion: 1,
          title: 'Rendering lifecycle', blocks }, answers: {},
        metadata: { localId: 'rendering-fixture', origin: 'local_source', updatedAt: now } });
    }, locale);
    const url = base + '/server/viewer/index.html?localAttemptId=rendering-fixture';
    await page.goto(url);
    const go = async index => {
      await page.locator('.block-stepper__node').nth(index).click();
      assert.equal(await page.locator('#viewer-answer-form > article').count(), 1);
      await page.waitForFunction(index => window.viewerSession.state.lastActiveIndex === index, index);
    };
    await page.locator('#answer-text').fill('Original 中文 answer');
    await page.locator('#answer-text').evaluate(control => {
      window.originalControl = control;control.setSelectionRange(3, 6);
      window.viewerSession.notifyStateChange();
    });
    assert(await page.locator('#answer-text').evaluate(control => control === window.originalControl
      && document.activeElement === control && control.selectionStart === 3 && control.selectionEnd === 6));
    await go(2);
    await page.evaluate(() => { window.originalControl.value = 'Detached edit';window.originalControl.dispatchEvent(new Event('input')); });
    assert.equal(await page.evaluate(() => window.viewerSession.state.answers.text.value), 'Original 中文 answer');
    await page.locator('#answer-number').fill('1.');
    await page.evaluate(() => window.viewerSession.notifyStateChange());
    assert.equal(await page.locator('#answer-number').inputValue(), '1.');
    await page.locator('#answer-number').fill('0');
    await go(3);
    await page.locator('[data-boolean-value="false"]').click();
    assert.equal(await page.locator('[data-boolean-value="false"]').getAttribute('aria-pressed'), 'true');
    await go(4);
    const order = await page.locator('[data-choice-value]').evaluateAll(nodes => nodes.map(n => n.dataset.choiceValue));
    await page.locator('[data-choice-value="B"]').click();
    await go(0);await go(4);
    assert.deepEqual(await page.locator('[data-choice-value]').evaluateAll(nodes => nodes.map(n => n.dataset.choiceValue)), order);
    assert.equal(await page.locator('[data-choice-value="B"]').getAttribute('aria-checked'), 'true');
    await page.evaluate(() => window.viewerSession.saveNow());
    await page.reload();await page.locator('#answer-choice').waitFor();
    assert.deepEqual(await page.locator('[data-choice-value]').evaluateAll(nodes => nodes.map(n => n.dataset.choiceValue)), order);
    assert.equal(await page.evaluate(() => window.viewerSession.state.lastActiveBlockId), 'choice');
    if (screenshots) await page.screenshot({ path: `${screenshots}/rendering-${locale}-${width}.png`, animations: 'disabled' });
    await go(1);
    assert.equal(await page.locator('#answer-text').inputValue(), 'Original 中文 answer');
    // Permission acquisition belongs to the original question; navigation cancels it.
    await page.evaluate(() => { window.holdPermission = true; });
    await page.locator('.question-card__voice-btn').click();
    await page.waitForFunction(() => typeof window.releasePermission === 'function');
    await go(5);
    await page.evaluate(() => window.releasePermission());
    await page.waitForFunction(() => !window.viewerSession.voice.active);
    assert.equal(await page.evaluate(() => window.recordingStarts), 0);
    await page.evaluate(() => { window.holdPermission = false; });
    await go(1);
    // Existing cancellation recovery must be explicitly discarded before another operation.
    await page.locator('.viewer-voice-recovery-actions button').last().click();
    // Language replacement retains answers and the existing cancellation behavior.
    await page.locator('.question-card__voice-btn').click();
    await page.waitForFunction(() => window.viewerSession.voice.active?.state === 'recording');
    await page.locator('.language-selector__trigger').click();
    await page.locator(`.language-selector__option[value="${locale === 'en' ? 'zh-Hant' : 'en'}"]`).click();
    await page.waitForFunction(() => !window.viewerSession.voice.active);
    assert.equal(await page.locator('#answer-text').inputValue(), 'Original 中文 answer');
    assert.equal(await page.locator('#viewer-answer-form > article').count(), 1);
    // A late image lookup must not create a blob URL after its card was disposed.
    await page.evaluate(() => {
      const session = window.viewerSession;
      session.state.viewerPayload.blocks.find(b => b.blockId === 'number').prompt.mediaRefs = [
        { usage: 'question_image', assetId: 'held-image' },
      ];
      const originalGet = session.storage.localAssets.get.bind(session.storage.localAssets);
      session.storage.localAssets.get = id => id === 'held-image'
        ? new Promise(resolve => { window.finishImageLookup = resolve; }) : originalGet(id);
      const originalCreate = URL.createObjectURL.bind(URL);
      window.imageURLs = 0;
      URL.createObjectURL = blob => { if (blob.type.startsWith('image/')) window.imageURLs++;return originalCreate(blob); };
    });
    await go(2);
    await page.waitForFunction(() => typeof window.finishImageLookup === 'function');
    await go(5);
    await page.evaluate(async () => {
      window.finishImageLookup({ binary: new Uint8Array([1]), metadata: { mimeType: 'image/png' } });
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    assert.equal(await page.evaluate(() => window.imageURLs), 0);
    assert.deepEqual(errors, []);
    console.log(`PASS rendering lifecycle ${locale} ${width}: stable focus/selection, disposed input, numeric draft, shuffle/resume, permission cancellation, language teardown and late image cleanup`);
    await context.close();
  }
} finally { await browser.close(); }
