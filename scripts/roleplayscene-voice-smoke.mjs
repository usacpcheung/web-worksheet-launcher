// Real player UI, isolated storage, synthetic microphone and processing only.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) for (const bubble of [false, true]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/voice-fixture', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/server/roleplayscene/styles/app.css"><main id="left"></main><div id="right"></div>' }));
    await page.goto(base + '/voice-fixture');
    await page.evaluate(async ({ locale, bubble }) => {
      const { setLocale } = await import('/server/app/i18n/index.js'); setLocale(locale);
      const { renderPlayer } = await import('/server/roleplayscene/scripts/player/player.js');
      const { RolePlaySceneDiscussionSession } = await import('/server/roleplayscene/scripts/player/discussion-state.js');
      window.musicInstances = [];
      window.Audio = class {
        constructor(src) { this.src = src; this.paused = true; window.musicInstances.push(this); }
        play() { this.paused = false; return Promise.resolve(); }
        pause() { this.paused = true; }
      };
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true });
      window.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['synthetic']) }); this.onstop?.(); }); } };
      const apiClient = { transcribeAudio: () => new Promise(resolve => { window.finishTranscript = () => resolve({ ok: true, data: { text: 'new segment' } }); }), rewriteText: async text => window.failRewrite ? { ok: false, error: { code: 'UPSTREAM_FAILED' } } : ({ ok: true, data: { text } }) };
      const project = { meta: { title: 'Voice practice' }, speakers: [], scenes: ['one', 'two'].map((id, i) => ({ id, type: i ? 'end' : 'start', dialogue: [{ text: 'Discuss your choice.' }], choices: i ? [] : [{ id: 'next', label: 'Next scene', nextSceneId: 'two', cueCardText: 'Explain your choice.' }], speechBubble: { enabled: bubble } })) };
      project.scenes[0].backgroundAudio = { objectUrl: 'synthetic-music' };
      const data = { project, audioGate: true }; const listeners = new Set();
      const store = { get: () => data, set: update => { Object.assign(data, update); for (const fn of listeners) fn(); }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
      window.redrawPlayer = () => store.set({ audioGate: false });
      window.discussion = new RolePlaySceneDiscussionSession({ apiClient }); window.discussion.bindProject(project);
      window.discussion.setText('one', 'Earlier discussion');
      window.cleanupPlayer = renderPlayer(store, document.querySelector('#left'), document.querySelector('#right'), () => {}, { initialSceneId: 'one', discussionSession: window.discussion, apiClient });
      window.restoreMusicPlayer = () => {
        window.cleanupPlayer();
        store.set({ audioGate: false });
        window.cleanupPlayer = renderPlayer(store, document.querySelector('#left'), document.querySelector('#right'), () => {}, {
          initialPlaybackState: { sceneHistory: ['one', 'two'], historyIndex: 1, currentSceneId: 'two' },
          discussionSession: window.discussion, apiClient,
        });
      };
      window.showMusicCover = () => {
        window.cleanupPlayer();
        store.set({ audioGate: false });
        window.cleanupPlayer = renderPlayer(store, document.querySelector('#left'), document.querySelector('#right'), () => {});
      };
      window.importSpacedScene = () => {
        window.cleanupPlayer();
        project.scenes[1].id = 'scene one 中文';
        window.discussion.bindProject(project);
        window.cleanupPlayer = renderPlayer(store, document.querySelector('#left'), document.querySelector('#right'), () => {}, {
          initialSceneId: 'scene one 中文', discussionSession: window.discussion, apiClient,
        });
      };
    }, { locale, bubble });
    if (bubble) {
      await page.getByRole('button', { name: locale === 'en' ? 'Choices' : '選項', exact: true }).click();
      await page.locator('.player-choice-cue-trigger').click();
    } else {
      await page.locator('.theater-utilities-toggle').click();
      await page.locator('.theater-utilities-section--discussion button').first().click();
    }
    const field = page.locator('.player-discussion-textarea');
    const add = page.getByRole('button', { name: locale === 'en' ? 'Add by voice' : '用語音加入', exact: true });
    await add.click();
    await page.waitForFunction(() => window.discussion.voice.active?.state === 'recording');
    assert.equal(await page.evaluate(() => window.musicInstances.at(-1).paused), true);
    assert.equal(await page.locator('.theater-utilities-section--music button').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.theater-utilities-section--music input').isDisabled(), true);
    await page.evaluate(() => window.redrawPlayer());
    assert.equal(await page.evaluate(() => window.discussion.voice.active?.state), 'recording', 'Same-scene redraw must not stop capture');
    // Exercise the gate-opening music action without closing the discussion (closing intentionally stops capture).
    await page.locator('.theater-utilities-section--music button').evaluate(button => button.click());
    assert.equal(await page.evaluate(() => window.discussion.voice.active?.state), 'recording', 'Unmute gate update must not stop capture');
    assert.equal(await page.evaluate(() => window.musicInstances.at(-1).paused), true);
    assert.equal(await field.evaluate(e => e.readOnly), true);
    assert.equal(await page.locator('.audio-play-all').isDisabled(), true);
    if (shots) await page.screenshot({ path: `${shots}/discussion-recording-${locale}-${width}-${bubble}.png` });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.discussion.voice.active?.state === 'transcribing');
    assert.equal(await page.evaluate(() => window.musicInstances.at(-1).paused), false);
    assert.equal(await page.locator('.player-discussion-voice-status').isVisible(), true);
    await page.locator('.player-discussion-voice-status button').first().click();
    assert.equal(await field.isVisible(), true);
    await page.evaluate(() => window.finishTranscript());
    await page.waitForFunction(() => !window.discussion.voice.active);
    assert.equal(await field.inputValue(), 'Earlier discussion new segment');
    await page.getByRole('button', { name: locale === 'en' ? 'Undo' : '復原', exact: true }).click();
    assert.equal(await field.inputValue(), 'Earlier discussion');
    if (locale === 'en' && width === 1280) {
      // Navigate while transcription is held; a late result must not steal focus.
      await add.click();
      await page.waitForFunction(() => window.discussion.voice.active?.state === 'recording');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.discussion.voice.active?.state === 'transcribing');
      if (!await page.locator('.player-choice-button').isVisible()) await page.getByRole('button', { name: 'Choices', exact: true }).click();
      await page.locator('.player-choice-button').click();
      await page.locator('.theater-utilities-toggle').click();
      assert.equal(await page.locator('.theater-utilities-section--discussion button').nth(1).isDisabled(), true);
      await page.locator('.theater-utilities-section--discussion button').first().click();
      await field.fill('Scene two typing');
      assert.equal(await add.isDisabled(), true);
      await page.locator('.player-discussion-input-panel .viewer-voice-status button').first().click();
      assert.equal(await field.inputValue(), 'Earlier discussion');
      assert.deepEqual(await page.locator('.theater-history-entry').evaluateAll(nodes => nodes.map(e => e.dataset.sceneId)), ['one', 'two']);
      assert.equal(await page.locator('.theater-history-entry[aria-current="step"]').getAttribute('data-scene-id'), 'one');
      await page.keyboard.press('Escape');
      await page.locator('.theater-utilities-toggle').click();
      await page.locator('.theater-history-entry[data-scene-id="two"]').click();
      await page.locator('.theater-utilities-toggle').click();
      await page.locator('.theater-utilities-section--discussion button').first().click();
      await field.focus();
      await page.evaluate(() => window.finishTranscript());
      await page.waitForFunction(() => !window.discussion.voice.active);
      assert.equal(await field.inputValue(), 'Scene two typing');
      assert.equal(await field.evaluate(e => e === document.activeElement), true);
      assert.equal(await page.evaluate(() => window.discussion.getText('one')), 'Earlier discussion new segment');
      await page.evaluate(() => { window.failRewrite = true; });
      await add.click();
      await page.waitForFunction(() => window.discussion.voice.active?.state === 'recording');
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await page.waitForFunction(() => window.discussion.voice.active?.state === 'transcribing');
      await page.evaluate(() => window.finishTranscript());
      await page.waitForFunction(() => !window.discussion.voice.active);
      const recovery = page.getByLabel('Recovered text');
      await recovery.fill('');
      assert.equal(await recovery.isVisible(), true);
      await recovery.fill('edited recovery');
      await page.evaluate(() => { window.failRewrite = false; });
      await page.getByRole('button', { name: 'Retry rewrite', exact: true }).click();
      await page.waitForFunction(() => !window.discussion.voice.active);
      assert.equal(await field.inputValue(), 'Scene two typing edited recovery');
    }
    assert.equal(await field.evaluate(e => e.getBoundingClientRect().right <= innerWidth), true);
    await page.evaluate(() => window.restoreMusicPlayer());
    await page.locator('.theater-utilities-toggle').click();
    await page.locator('.theater-history-entry[data-scene-id="one"]').click();
    await page.locator('.theater-utilities-toggle').click();
    await page.locator('.theater-utilities-section--discussion button').first().click();
    await add.click();
    await page.waitForFunction(() => window.discussion.voice.active?.state === 'recording');
    await page.locator('.theater-history-entry[data-scene-id="two"]').evaluate(button => button.click());
    await page.waitForFunction(() => window.discussion.voice.active?.state === 'transcribing');
    assert.equal(await page.evaluate(() => window.discussion.voice.active.blockId), 'one', 'Actual navigation stops capture for its original scene');
    await page.evaluate(() => window.discussion.voice.cancel());
    await page.evaluate(() => window.restoreMusicPlayer());
    await page.locator('.theater-utilities-toggle').click();
    const music = page.locator('.theater-utilities-section--music');
    assert.equal(await music.isVisible(), true, 'Restored later scene retains inherited music controls');
    assert.equal(await music.locator('input').isDisabled(), true);
    await music.locator('button').click(); // Explicit activation keeps the existing menu.
    assert.equal(await page.evaluate(() => window.musicInstances.at(-1).paused), false);
    assert.equal(await music.isVisible(), true);
    await page.evaluate(() => {
      window.musicInstances.at(-1).paused = true;
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    assert.equal(await music.locator('button').getAttribute('aria-pressed'), 'true', 'Browser-restored pause updates the existing control');
    assert.equal(await music.locator('input').isDisabled(), true);
    await music.locator('button').click();
    assert.equal(await page.evaluate(() => window.musicInstances.at(-1).paused), false, 'One click enables paused music');
    assert.equal(await music.locator('button').getAttribute('aria-pressed'), 'false');
    await music.locator('button').click(); // Turn music off before recording.
    await page.locator('.theater-utilities-section--discussion button').first().click();
    await add.click();
    await page.waitForFunction(() => window.discussion.voice.active?.state === 'recording');
    await page.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
    await page.waitForFunction(() => !window.discussion.voice.active);
    assert.equal(await page.evaluate(() => window.musicInstances.at(-1).paused), true, 'Previously off music stays off after cancellation');
    await page.keyboard.press('Escape');
    await page.locator('.theater-utilities-toggle').click();
    if (shots) await page.screenshot({ path: `${shots}/discussion-restored-music-${locale}-${width}-${bubble}.png` });
    await page.evaluate(() => window.showMusicCover());
    await page.locator('.theater-utilities-toggle').click();
    const coverMusic = page.locator('.background-audio-controls');
    await coverMusic.locator('button').click();
    assert.equal(await coverMusic.isVisible(), true);
    await page.evaluate(() => {
      window.musicInstances.at(-1).paused = true;
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    assert.equal(await coverMusic.locator('button').getAttribute('aria-pressed'), 'true');
    await coverMusic.locator('button').click();
    assert.equal(await page.evaluate(() => window.musicInstances.at(-1).paused), false);
    await page.evaluate(() => window.importSpacedScene());
    await page.locator('.theater-utilities-toggle').click();
    await page.locator('.theater-utilities-section--discussion button').first().click();
    assert.equal(await add.evaluate(button => {
      const ids = button.getAttribute('aria-describedby').split(/\s+/);
      return ids.length === 1 && Boolean(document.getElementById(ids[0]));
    }), true, 'Imported scene IDs cannot break the status description');
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.cleanupPlayer());
    await context.close();
  }
  console.log('PASS: discussion voice, close/reopen during processing, exact Undo, both playback modes/locales/widths');
} finally { await browser.close(); }
