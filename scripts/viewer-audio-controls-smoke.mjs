import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  // Direct module boundary: use browser events/AbortSignal/geometry, with a
  // deliberately controlled playback promise. No application bootstrap needed.
  const isolated = await browser.newContext({ viewport: { width: 390, height: 700 } });
  const direct = await isolated.newPage();
  const directErrors = [];
  direct.on('pageerror', error => directErrors.push(error.message));
  await direct.route(`${base}/audio-controls-fixture`, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><link rel="stylesheet" href="/server/viewer/main.css"></head><body></body></html>',
  }));
  await direct.goto(`${base}/audio-controls-fixture`);
  await direct.evaluate(async () => {
    const { createViewerAudioControls } = await import('/server/viewer/audio-controls.js');
    const { t, setLocale } = await import('/server/app/i18n/index.js');
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const tracked = [], observers = [], pendingFrames = new Set();
    for (const target of [document, window, window.visualViewport].filter(Boolean)) {
      const original = target.addEventListener.bind(target);
      target.addEventListener = (type, listener, options) => {
        tracked.push({ target, type, signal: options?.signal });
        return original(type, listener, options);
      };
    }
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback) { super(callback); this.disconnected = false; observers.push(this); }
      disconnect() { this.disconnected = true; super.disconnect(); }
    };
    const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => {
      const id = request(time => { pendingFrames.delete(id); callback(time); });
      pendingFrames.add(id); return id;
    };
    window.cancelAnimationFrame = id => { pendingFrames.delete(id); cancel(id); };
    const controls = createViewerAudioControls({ createIcon: name => `<svg data-icon="${name}"></svg>`, t });
    const tracks = ['english', 'cantonese', 'mandarin'].map(language => ({ language, assetId: language, sourceTextHash: 'fixture' }));
    const feedback = [], calls = [];
    let hooks, resolvePlayback, stops = 0;
    const session = {
      playAssetAudio(id, nextHooks) {
        calls.push(id); hooks = nextHooks;
        return new Promise(resolve => { resolvePlayback = resolve; });
      },
      stopActiveAudio() { stops++; hooks?.onInterrupted(); },
    };
    const mount = (audioTracks, kind = 'question') => {
      const controller = new AbortController();
      const root = controls.createViewerAudioControl({ audioTracks, kind, session,
        signal: controller.signal, reportMediaFeedback: text => feedback.push(text) });
      document.body.append(root);
      return { root, controller, trigger: root.querySelector('button'), menu: root.querySelector('.viewer-audio-control__menu') };
    };
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    check(controls.createViewerAudioControl({ audioTracks: [], session }) === null, 'no audio means no control');
    const first = mount(tracks), second = mount(tracks, 'option');
    first.trigger.click();
    check(!first.menu.hidden, 'first menu opens');
    check([...first.menu.children].map(n => n.dataset.audioLanguage).join() === 'cantonese,mandarin,english', 'language order');
    check(document.activeElement === first.menu.children[0], 'opening focuses first language');
    second.trigger.click();
    check(first.menu.hidden && !second.menu.hidden, 'one menu owner across question and option');
    second.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(second.menu.hidden && document.activeElement === second.trigger, 'Escape restores trigger focus');
    first.trigger.click();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check(first.menu.hidden, 'outside pointer closes menu');
    first.trigger.click();
    controls.closeOpenViewerAudioMenu({ restoreFocus: true });
    check(first.menu.hidden && document.activeElement === first.trigger, 'navigation close restores focus when requested');

    first.trigger.click();
    first.menu.children[0].click();
    check(first.trigger.disabled && calls.length === 1, 'pending playback is busy');
    first.trigger.click();
    check(calls.length === 1, 'pending playback cannot start twice');
    hooks.onStart(); resolvePlayback({ ok: true }); await tick();
    check(first.root.classList.contains('is-playing') && !first.trigger.disabled, 'successful start shows Stop');
    first.trigger.click();
    check(stops === 1 && !first.root.classList.contains('is-playing'), 'Stop delegates and resets');

    const single = mount(tracks.slice(0, 1));
    check(!single.menu, 'single track has no menu');
    single.trigger.click();
    const detached = single.root.outerHTML, feedbackCount = feedback.length;
    single.controller.abort(); single.root.remove();
    hooks.onStart(); hooks.onEnded(); hooks.onError(); hooks.onInterrupted();
    resolvePlayback({ ok: false, reason: 'missing-asset' }); await tick();
    check(single.root.outerHTML === detached, 'late results cannot update a disposed control');
    check(feedback.length === feedbackCount, 'late results cannot publish feedback for a disposed control');

    // Disposing a menu cancels both a scheduled frame and its observer/listeners.
    first.trigger.click(); window.dispatchEvent(new Event('resize'));
    first.controller.abort(); first.root.remove();
    second.controller.abort(); second.root.remove(); await tick();
    for (let index = 0; index < 12; index++) {
      const item = mount(tracks, index % 2 ? 'option' : 'question');
      item.trigger.click(); window.dispatchEvent(new Event('resize'));
      item.controller.abort(); item.root.remove();
    }
    await tick();
    check(observers.every(observer => observer.disconnected), 'position observers are disconnected');
    check(tracked.filter(item => item.signal).every(item => item.signal.aborted), 'position listeners are aborted');
    check(pendingFrames.size === 0, 'position frames are canceled');
    check(tracked.filter(item => item.target === document && item.type === 'pointerdown').length === 1,
      'repeated controls reuse one page-lifetime dismissal listener');
    for (const locale of ['en', 'zh-Hant']) {
      setLocale(locale, { persist: false });
      const item = mount(tracks);
      check(item.trigger.getAttribute('aria-label') === t('viewer.audio.chooseQuestionAudioLanguageAriaLabel'), 'current locale labels');
      item.controller.abort(); item.root.remove();
    }
  });
  assert.deepEqual(directErrors, []);
  await isolated.close();

  // Real playback uses local WAV assets and the unchanged ViewerAttemptSession.
  // It does not call voice, rewrite, generation, authentication or server writes.
  for (const [locale, width] of [['en', 1280], ['zh-Hant', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: false, error: { code: 'UNAUTHORIZED' } }, status: 401 }));
    await page.goto(`${base}/server/viewer/`);
    await page.evaluate(async locale => {
      localStorage.setItem('worksheetLauncher.locale', locale);
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      const rate = 8000, samples = rate * 6, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
      const tag = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
      tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      tag(36, 'data'); view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 440 / rate) * 1000, true);
      const now = new Date().toISOString();
      await viewerStorage.localAssets.put({ localId: 'audio-fixture', binary: bytes,
        metadata: { localId: 'audio-fixture', origin: 'local_source', updatedAt: now, mimeType: 'audio/wav' } });
      const tracks = ['english', 'cantonese'].map(language => ({ language, assetId: 'audio-fixture', sourceTextHash: 'fixture' }));
      const blocks = [
        { blockId: 'choice', position: 0, kind: 'question', prompt: { text: 'Audio question 題目音訊', audioTracks: tracks },
          responseConfig: { inputType: 'multiple_choice', selectionMode: 'single', options: [
            { value: 'a', label: 'First 第一項', audioTracks: tracks },
            { value: 'b', label: 'Second 第二項', mediaRefs: [{ usage: 'option_audio', assetId: 'audio-fixture' }] },
          ] } },
        { blockId: 'legacy', position: 1, kind: 'question', prompt: { text: 'Legacy 舊音訊', mediaRefs: [{ usage: 'question_audio', assetId: 'audio-fixture' }] }, responseConfig: { inputType: 'text', maxLength: 100 } },
      ];
      await viewerStorage.attempts.put({ localId: 'audio-controls', localAttemptId: 'audio-controls', status: 'in_progress', startedAt: now,
        viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', snapshotVersion: 1, title: 'Audio controls', blocks },
        answers: { choice: { value: 'b' } }, metadata: { localId: 'audio-controls', origin: 'local_source', updatedAt: now } });
    }, locale);
    await page.goto(`${base}/server/viewer/?localAttemptId=audio-controls`);
    const question = page.locator('[data-block-id="choice"] .viewer-audio-control--question');
    await question.waitFor();
    const before = await page.evaluate(() => JSON.stringify(window.viewerSession.state.answers));
    await page.unrouteAll({ behavior: 'wait' });
    await context.setOffline(true);
    await question.locator('button').first().click();
    await question.locator('[data-audio-language="english"]').click();
    await page.waitForFunction(() => window.viewerSession.activeAudio?.currentTime > 0.1);
    await page.evaluate(() => { window.previousAudio = window.viewerSession.activeAudio; });
    const option = page.locator('[data-block-id="choice"] .viewer-audio-control--option').first();
    await option.locator('button').first().click();
    await option.locator('[data-audio-language="cantonese"]').click();
    await page.waitForFunction(() => window.viewerSession.activeAudio !== window.previousAudio && window.viewerSession.activeAudio?.currentTime > 0.1);
    assert(await page.evaluate(() => window.previousAudio.paused));
    assert.equal(await page.evaluate(() => JSON.stringify(window.viewerSession.state.answers)), before);
    await option.locator('button').first().click();
    assert.equal(await page.evaluate(() => window.viewerSession.activeAudio), null);
    const legacyOption = page.locator('[data-block-id="choice"] .viewer-audio-control--option').last();
    await legacyOption.locator('button').click();
    await page.waitForFunction(() => window.viewerSession.activeAudio?.currentTime > 0.1);
    await legacyOption.locator('button').click();
    const legacyQuestion = page.locator('[data-block-id="legacy"] .viewer-audio-control--question');
    await legacyQuestion.locator('button').click();
    await page.waitForFunction(() => window.viewerSession.activeAudio?.currentTime > 0.1);
    await page.waitForFunction(() => !window.viewerSession.activeAudio);
    assert(!await legacyQuestion.evaluate(root => root.classList.contains('is-playing')));
    assert.equal(await page.evaluate(() => JSON.stringify(window.viewerSession.state.answers)), before);
    await context.setOffline(false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Audio control ownership, cleanup, late callbacks, locales and real offline playback passed');
} finally {
  await browser.close();
}
