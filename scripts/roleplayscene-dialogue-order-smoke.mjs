import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) for (const bubble of [false, true]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/order-fixture', r => r.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/server/roleplayscene/styles/app.css"><style>body{padding:16px}#right{max-width:850px;margin:auto}#left{display:none}</style><div id="left"></div><div id="right"></div>' }));
    await page.goto(base + '/order-fixture');
    await page.evaluate(async locale => {
      const { Store } = await import('/server/roleplayscene/scripts/state.js');
      const { createProject, createScene } = await import('/server/roleplayscene/scripts/model.js');
      const { renderEditor } = await import('/server/roleplayscene/scripts/editor/editor.js');
      window.store = new Store(); store.setLocale(locale);
      const scene = createScene({ id: 'one', type: 'start', dialogue: ['A', 'B', 'C'].map(text => ({ text, speakerId: null, audio: null })) });
      store.set({ project: createProject({ scenes: [scene] }) });
      window.editorCleanup = renderEditor(store, document.querySelector('#left'), document.querySelector('#right'), () => {});
    }, locale);
    const move = page.locator('[data-focus-key="dialogue-move-one-2--1"]');
    await move.click();
    assert.deepEqual(await page.evaluate(() => store.get().project.scenes[0].dialogue.map(l => l.text)), ['A', 'C', 'B']);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.focusKey), 'dialogue-move-one-1--1');
    assert.equal(await page.locator('[data-focus-key="dialogue-move-one-0--1"]').isDisabled(), true);
    assert.equal(await page.locator('[data-focus-key="dialogue-move-one-2-1"]').isDisabled(), true);
    const styles = await page.evaluate(() => {
      const row = document.querySelector('.dialogue-line');
      const style = el => { const s = getComputedStyle(el); return [s.fontFamily, s.fontSize, s.fontWeight, s.color]; };
      return [style(row.querySelector('.field > span')), style(row.querySelector('.dialogue-t2a-controls__preset > span'))];
    });
    assert.deepEqual(styles[0], styles[1]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    if (shots) await page.screenshot({ path: `${shots}/dialogue-order-${locale}-${width}.png`, fullPage: true });
    await page.evaluate(async bubble => {
      const { serializeProject, hydrateProject } = await import('/server/roleplayscene/scripts/storage.js');
      const data = structuredClone(serializeProject(store.get().project));
      editorCleanup();
      store.set({ project: hydrateProject(data) });
      const { renderPlayerUI } = await import('/server/roleplayscene/scripts/player/ui.js');
      window.played = [];
      window.AudioContext = undefined; window.webkitAudioContext = undefined;
      window.Audio = class extends EventTarget {
        constructor() { super(); window.audio = this; this.paused = true; }
        play() { this.paused = false; played.push(this.src); return Promise.resolve(); }
        pause() { this.paused = true; }
      };
      const project = store.get().project;
      project.scenes[0].speechBubble = { enabled: bubble, anchors: [] };
      project.scenes[0].dialogue.forEach(line => { line.audio = { objectUrl: line.text }; });
      document.querySelector('#left').style.display = 'block';
      window.showPlayer = () => renderPlayerUI({ stageEl: document.querySelector('#left'), uiEl: document.querySelector('#right'), project, scene: project.scenes[0], onChoice: () => {} });
      window.playerCleanup = showPlayer();
    }, bubble);
    const text = page.locator(bubble ? '.speech-play-bubble--center' : '.theater-dialogue-text');
    assert.equal(await text.innerText(), 'A');
    await page.locator('.theater-toolbar__button--next').click();
    assert.equal(await text.innerText(), 'C');
    await page.locator('.theater-toolbar__button--next').click();
    assert.equal(await text.innerText(), 'B');
    await page.evaluate(() => { playerCleanup(); playerCleanup = showPlayer(); });
    await page.locator('.audio-play-all').click();
    await page.waitForFunction(() => played.length === 1);
    await page.evaluate(() => audio.dispatchEvent(new Event('ended')));
    await page.waitForFunction(() => played.length === 2);
    await page.evaluate(() => audio.dispatchEvent(new Event('ended')));
    await page.waitForFunction(() => played.length === 3);
    assert.deepEqual(await page.evaluate(() => played), ['A', 'C', 'B']);
    assert.deepEqual(errors, []);
    console.log(`PASS ${locale} ${width} bubble=${bubble}: order, focus, label styles, persistence round trip, Next and Play all`);
    await page.close();
  }
} finally { await browser.close(); }
