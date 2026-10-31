import { chooseViewerSection } from './viewer-navigation-test-helpers.mjs';
// Synthetic media/provider fixtures only. No production resources are created.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
 for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let releaseRewrite, requestStarted;
  let ready = new Promise(resolve => { requestStarted = resolve; });
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
   if (route.request().url().endsWith('/rewrite')) {
    await new Promise(resolve => { releaseRewrite = resolve; requestStarted(); });
    return route.fulfill({ json: { ok: true, result: 'Rewritten original answer' } });
   }
   return route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] }, result: 'Transcript' } });
  });
  await page.addInitScript(() => {
   window.Audio = class extends EventTarget { play() { return Promise.resolve(); } pause() {} load() {} removeAttribute() {} };
   Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
   window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['fixture'], { type: this.mimeType }) }); this.onstop?.(); }); }
   };
  });
  await page.goto(base + '/server/viewer/');
  await page.evaluate(async locale => {
   localStorage.setItem('worksheetLauncher.locale', locale);
   const { viewerStorage } = await import('/server/viewer/storage/index.js');
   const now = new Date().toISOString();
   const blocks = [
    { blockId: 'intro', kind: 'content', content: { text: 'Reading introduction. 閱讀說明。\n'.repeat(20) } },
    { blockId: 'q1', kind: 'question', prompt: { text: 'First question 第一題', audioTracks: [{ language: 'english', assetId: 'audio', sourceTextHash: 'fixture' }] }, responseConfig: { inputType: 'text', maxLength: 300 } },
    { blockId: 'reading', kind: 'content', content: { text: 'Middle reading. 中間閱讀。\n'.repeat(25) } },
    { blockId: 'q2', kind: 'question', prompt: { text: 'Second question 第二題' }, responseConfig: { inputType: 'text', maxLength: 300 } },
    { blockId: 'end', kind: 'content', content: { text: 'End 完' } },
   ].map((block, position) => ({ ...block, position }));
   await viewerStorage.localAssets.put({ localId: 'audio', binary: new Uint8Array([1]), metadata: { localId: 'audio', origin: 'local_source', updatedAt: now, mimeType: 'audio/mpeg' } });
   await viewerStorage.attempts.put({ localId: 'continuous', localAttemptId: 'continuous', startedAt: now, status: 'in_progress',
    lastActiveBlockId: 'q1', lastActiveIndex: 1, viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', snapshotVersion: 1, title: 'Continuous worksheet', blocks },
    answers: { q1: { value: 'Original answer' } }, metadata: { localId: 'continuous', origin: 'local_source', updatedAt: now } });
  }, locale);
  await page.goto(base + '/server/viewer/?localAttemptId=continuous');
  const section = id => page.locator(`.viewer-block-section[data-block-id="${id}"]`);
  const current = async () => page.evaluate(() => window.viewerSession.state.lastActiveBlockId);
  const jump = async index => {
   await chooseViewerSection(page, index);
   await page.waitForFunction(index => window.viewerSession.state.lastActiveIndex === index, index);
  };
  await section('q1').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelector('[data-block-id="q1"]').getBoundingClientRect().top >= 0
   && document.querySelector('[data-block-id="q1"]').getBoundingClientRect().top < innerHeight / 2);
  assert.equal(await page.locator('.viewer-block-section').count(), 5);
  await page.evaluate(() => {
   window.scrollCalls = []; const originalScroll = window.scrollTo.bind(window); window.scrollTo = (...args) => { window.scrollCalls.push(args); return originalScroll(...args); };
   window.transitions = [];
   const voice = window.viewerSession.voice, original = voice.navigate.bind(voice);
   voice.navigate = () => { window.transitions.push(window.viewerSession.state.lastActiveBlockId); return original(); };
  });
  // One explicit jump, no intermediary activations, no remount of the old answer.
  await page.locator('#answer-q1').evaluate(node => { window.firstAnswer = node; });
  await jump(3);
  assert.deepEqual(await page.evaluate(() => window.transitions), ['q2']);
  assert(await page.locator('#answer-q1').evaluate(node => node === window.firstAnswer));
  // Focus/click a noncurrent answer activates it before editing.
  await page.locator('#answer-q1').focus();
  assert.equal(await current(), 'q1');
  await page.locator('#answer-q1').fill('Original answer');
  // Playback is unaffected by layout-only changes, but ends on a real transition.
  await section('q1').locator('.viewer-audio-control__trigger').click();
  await page.waitForFunction(() => Boolean(window.viewerSession.activeAudio));
  await section('intro').evaluate(el => { el.style.paddingBottom = '100px'; });
  await page.setViewportSize({ width, height: 780 });
  assert.equal(await current(), 'q1');
  assert(await page.evaluate(() => Boolean(window.viewerSession.activeAudio)));
  await jump(3);
  assert.equal(await page.evaluate(() => Boolean(window.viewerSession.activeAudio)), false);
  await page.setViewportSize({ width, height: 900 });
  // A deliberate wheel scroll updates current section without moving focus.
  await jump(1);
  await page.mouse.move(width / 2, 180);
  const delta = await section('reading').evaluate(el => el.getBoundingClientRect().top - 120);
  await page.mouse.wheel(0, delta);
  await page.waitForFunction(() => window.viewerSession.state.lastActiveBlockId === 'reading');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.blockId), 'q1');
  // A touch beginning on another answer is not a click or focus activation.
  await page.locator('#answer-q2').dispatchEvent('pointerdown', { pointerType: 'touch' });
  assert.equal(await current(), 'reading');
  // Programmatic/layout scrolling alone cannot activate another section.
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await current(), 'reading');
  await jump(1);
  await section('q1').locator('.question-card__rewrite-btn').click();
  await ready;
  assert.equal(await page.locator('.viewer-voice-status').count(), 1);
  assert.equal(await page.locator('.viewer-voice-status [role="status"]').count(), 1);
  await jump(3);
  await page.locator('#answer-q2').fill('Typing in second answer');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const scrollBefore = await page.evaluate(() => ({ y: scrollY, top: document.querySelector('#answer-q2').getBoundingClientRect().top }));
  assert(await page.locator('#answer-q2').evaluate(node => node.getBoundingClientRect().bottom <= document.querySelector('.viewer-operation-panel').getBoundingClientRect().top), 'newly focused answer clears the fixed operation panel');
  const scrollCalls = await page.evaluate(() => window.scrollCalls.length);
  await page.setViewportSize({ width, height: 780 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await current(), 'q2', 'resize does not navigate');
  assert(await page.locator('#answer-q2').evaluate(node => node.getBoundingClientRect().bottom <= document.querySelector('.viewer-operation-panel').getBoundingClientRect().top), 'resize keeps the focused answer clear of controls');
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const settledTop = await page.locator('#answer-q2').evaluate(node => node.getBoundingClientRect().top);
  releaseRewrite();
  await page.waitForFunction(() => !window.viewerSession.voice.active);
  assert.equal(await page.evaluate(() => window.scrollCalls.length), scrollCalls, 'completion does not initiate navigation');
  assert.equal(await page.locator('#answer-q1').inputValue(), 'Rewritten original answer');
  assert.equal(await page.locator('#answer-q2').inputValue(), 'Typing in second answer');
  assert(await page.locator('#answer-q2').evaluate(node => document.activeElement === node));
  const scrollAfter = await page.evaluate(() => ({ y: scrollY, top: document.querySelector('#answer-q2').getBoundingClientRect().top }));
  assert.ok(Math.abs(scrollAfter.top - settledTop) <= 1, 'background result must not shift the current answer: ' + JSON.stringify({settledTop, scrollAfter}));
  // A focused answer deliberately scrolled off-screen is not pinned by resize.
  await page.mouse.move(width / 2, 100);
  await page.mouse.wheel(0, -10000);
  await page.waitForFunction(() => window.viewerSession.state.lastActiveBlockId === 'intro');
  await page.setViewportSize({ width, height: 780 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await current(), 'intro');
  assert(await page.locator('#answer-q2').evaluate(node => node.getBoundingClientRect().top >= innerHeight));
  await page.setViewportSize({ width, height: 900 });
  // Recording survives layout changes; scrolling to another section stops capture.
  ready = new Promise(resolve => { requestStarted = resolve; });
  await jump(1);
  await section('q1').locator('.question-card__voice-btn').click();
  await page.waitForFunction(() => window.viewerSession.voice.active?.state === 'recording');
  // Acceptance investigation: opening the operation panel and elapsed-time updates
  // must not select the leading reading or stop capture without user navigation.
  await page.waitForTimeout(1800);
  assert.equal(await current(), 'q1', 'idle recording retains its originating section');
  assert.equal(await page.evaluate(() => window.viewerSession.voice.active?.state), 'recording');
  // The recording panel must not move the reading line into the previous section.
  // A real small wheel gesture exposes the deferred geometry transition that idle
  // and large-departure checks cannot catch.
  await page.mouse.move(width / 2, 100);
  const beforeSmallWheel = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 8);
  await page.waitForFunction(y => scrollY > y + 1, beforeSmallWheel);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const recordingGeometry = await page.evaluate(() => ({
   current: window.viewerSession.state.lastActiveBlockId,
   state: window.viewerSession.voice.active?.state,
   questionTop: document.querySelector('[data-block-id="q1"]').getBoundingClientRect().top,
   panelTop: document.querySelector('.viewer-operation-panel').getBoundingClientRect().top,
   height: innerHeight,
  }));
  assert.equal(await current(), 'q1', 'small downward scroll must not reverse to preceding reading: ' + JSON.stringify(recordingGeometry));
  assert.equal(await page.evaluate(() => window.viewerSession.voice.active?.state), 'recording');
  // Growing the panel and explicitly realigning Q1 must use the same reading
  // geometry. Small reverse movement within Q1 must also retain capture.
  await page.locator('.viewer-operation-panel').evaluate(node => { node.style.minHeight = '260px'; });
  await jump(1);
  await page.mouse.move(width / 2, 100);
  const realignedY = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 8);
  await page.waitForFunction(y => scrollY > y + 1, realignedY);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await current(), 'q1', 'panel resize and explicit alignment preserve the reading line');
  assert.equal(await page.evaluate(() => window.viewerSession.voice.active?.state), 'recording');
  const forwardY = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, -4);
  await page.waitForFunction(y => scrollY < y - 1, forwardY);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await current(), 'q1', 'small reverse movement remains inside Q1');
  assert.equal(await page.evaluate(() => window.viewerSession.voice.active?.state), 'recording');
  await page.locator('.viewer-operation-panel').evaluate(node => { node.style.minHeight = ''; });
  await section('intro').evaluate(node => { node.style.paddingBottom = '150px'; });
  await page.setViewportSize({ width, height: 780 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await current(), 'q1', 'layout and viewport changes do not navigate during recording');
  assert.equal(await page.evaluate(() => window.viewerSession.voice.active?.state), 'recording');
  await page.mouse.move(width / 2, 100);
  await page.mouse.wheel(0, await section('reading').evaluate(el => el.getBoundingClientRect().top - 100));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => window.viewerSession.state.lastActiveBlockId === 'reading');
  await ready;
  await page.locator('.viewer-operation-panel button').last().click();
  releaseRewrite();
  await page.waitForFunction(() => !window.viewerSession.voice.active);
  // A genuine reverse boundary crossing still stops recording; successful late
  // processing remains with Q1 and must not pull the student back from reading.
  // Resolve the previous canceled operation through its real recovery UI first.
  await jump(1);
  await section('q1').locator('.viewer-voice-recovery-actions button').last().click();
  await page.locator('#answer-q1').fill('');
  ready = new Promise(resolve => { requestStarted = resolve; });
  await jump(1);
  await section('q1').locator('.question-card__voice-btn').click();
  await page.waitForFunction(() => window.viewerSession.voice.active?.state === 'recording');
  await page.mouse.move(width / 2, 100);
  // The voice button may require scrolling within a tall mobile question.
  // Cross the real boundary instead of assuming a fixed 100px reaches it.
  const reverseDistance = await section('q1').evaluate(node => Math.max(100, innerHeight * .45 - node.getBoundingClientRect().top + 100));
  await page.mouse.wheel(0, -reverseDistance);
  await page.waitForFunction(() => window.viewerSession.state.lastActiveBlockId === 'intro');
  await ready;
  const beforeReverseCompletion = await page.evaluate(() => ({ y: scrollY, focus: document.activeElement.id }));
  releaseRewrite();
  await page.waitForFunction(() => !window.viewerSession.voice.active);
  assert.equal(await current(), 'intro');
  assert.equal(await page.locator('#answer-q1').inputValue(), 'Rewritten original answer');
  assert.equal(await page.locator('#answer-q2').inputValue(), 'Typing in second answer');
  assert.deepEqual(await page.evaluate(() => ({ y: scrollY, focus: document.activeElement.id })), beforeReverseCompletion);
  // Short final section remains reachable; resume restores identity and position.
  await jump(3);
  await page.mouse.move(width / 2, 100);
  await page.mouse.wheel(0, 10000);
  await page.waitForFunction(() => window.viewerSession.state.lastActiveBlockId === 'end');
  await page.evaluate(() => window.viewerSession.saveNow());
  await page.reload();
  await section('end').waitFor();
  assert.equal(await current(), 'end');
  await page.keyboard.press('Tab');
  await page.evaluate(() => { window.scrollCalls = []; const scroll = window.scrollTo.bind(window); window.scrollTo = (...args) => { window.scrollCalls.push(args); return scroll(...args); }; });
  await section('intro').evaluate(node => { node.style.paddingBottom = '200px'; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.scrollCalls.length), 0, 'late layout cannot resume-jump after keyboard interaction (native anchoring remains allowed)');
  await page.keyboard.press('Home');
  await page.waitForFunction(() => window.viewerSession.state.lastActiveBlockId === 'intro');
  await page.keyboard.press('End');
  await page.waitForFunction(() => window.viewerSession.state.lastActiveBlockId === 'end');
  await page.keyboard.press('Control+Home');
  await page.waitForFunction(() => window.viewerSession.state.lastActiveBlockId === 'intro');
  await page.keyboard.press('Control+End');
  await page.waitForFunction(() => window.viewerSession.state.lastActiveBlockId === 'end');
  assert.equal(await page.locator('#answer-q2').inputValue(), 'Typing in second answer');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (shots) await page.screenshot({ path: `${shots}/continuous-${locale}-${width}.png`, animations: 'disabled' });
  // A content-only worksheet and stale saved identity use the existing fallback.
  await page.evaluate(async () => {
   await window.viewerSession.saveNow();
   const { viewerStorage } = await import('/server/viewer/storage/index.js');
   const record = await viewerStorage.attempts.get('continuous');
   record.viewerPayload.blocks = [{ blockId: 'only-reading', kind: 'content', position: 0, content: { text: 'Reading only' } }];
   record.lastActiveBlockId = 'removed'; record.lastActiveIndex = 99;
   await viewerStorage.attempts.put(record);
  });
  await page.reload(); await section('only-reading').waitFor();
  assert.equal(await current(), 'only-reading');
  assert.equal(await page.locator('.viewer-operation-panel').isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
 }
 console.log('PASS continuous sections, resume, interaction activation, single-transition jumps, scrolling, layout preservation, audio interruption, shared operation status and off-screen results in both locales and widths');
} finally { await browser.close(); }
