// Real app imports and playback, isolated browser storage, synthetic local media.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createStoredZip } from '../server/editor/zip-utils.js';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);

function fixture({ title, image, music, bubble }) {
  const width = image === 'portrait' ? 400 : 1200;
  const height = image === 'portrait' ? 900 : 600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#526a81"/><rect x="5" y="5" width="${width - 10}" height="${height - 10}" fill="none" stroke="#d5e9f4" stroke-width="10"/><circle cx="${width / 2}" cy="${height / 2}" r="70" fill="#819caf"/></svg>`;
  const entries = [
    { path: 'manifest.json', data: JSON.stringify({ format: 'roleplayscene-package', packageVersion: 1, assets: [] }) },
    { path: 'content/project.json', data: JSON.stringify({ meta: { title }, scenes: [
      { id: 'start', type: 'start', image: image === 'none' ? null : { name: 'cover.svg', type: 'image/svg+xml', path: 'media/cover.svg' },
        backgroundAudio: music ? { name: 'music.wav', type: 'audio/wav', path: 'media/music.wav' } : null,
        speechBubble: { enabled: bubble, anchors: [{ id: 'anchor', x: 0.5, y: 0.5, pointer: 'bottom' }] },
        dialogue: [{ text: 'Welcome', anchorId: 'anchor' }], choices: [{ id: 'next', label: 'Finish', nextSceneId: 'end' }] },
      { id: 'end', type: 'end', dialogue: [], choices: [] },
    ] }) },
  ];
  if (image !== 'none') entries.push({ path: 'media/cover.svg', data: svg });
  if (music) entries.push({ path: 'media/music.wav', data: wav });
  return { name: 'intro.zip', mimeType: 'application/zip', buffer: Buffer.from(createStoredZip(entries)) };
}

const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 568 }]) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width === 320 });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.goto(base + '/server/roleplayscene/index.html');
      assert.equal(await page.title(), 'RolePlayScene');
      const title = locale === 'en' ? 'A visit to the tea shop' : '一起到茶館喝茶';
      const start = page.locator('.player-intro-begin');
      const readLayout = () => page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; };
        return { frame: rect('.player-intro-frame'), title: rect('.player-intro-title'), button: rect('.player-intro-begin'), stage: rect('.stage') };
      });
      const importAndPlay = async config => {
        if (await start.count() || await page.locator('.theater-overlay').count()) await page.locator('#mode-edit').click();
        await page.locator('#file-input').setInputFiles(fixture(config));
        await page.locator('#import-confirm-accept').click();
        await page.waitForFunction(() => document.querySelector('#file-input').value === '');
        const dismiss = page.locator('.app-messages__dismiss');
        if (await dismiss.isVisible()) await dismiss.click();
        await page.locator('#mode-play').click();
        await start.waitFor();
        await page.evaluate(async () => {
          const img = document.querySelector('.player-intro-frame > img');
          if (img) await img.decode();
          await document.fonts.ready;
          await new Promise(requestAnimationFrame);
        });
      };
      let baseline;
      for (const image of ['none', 'landscape', 'portrait']) for (const music of [false, true]) for (const bubble of [false, true]) {
        await importAndPlay({ title, image, music, bubble });
        const layout = await readLayout();
        baseline ??= layout;
        const label = `${locale} ${viewport.width} ${image} music=${music} bubble=${bubble}`;
        assert.ok(Math.abs(layout.button.cy - layout.frame.cy) < 1, `${label}: Start vertically centred`);
        assert.ok(Math.abs(layout.button.cx - layout.frame.cx) < 1, `${label}: Start horizontally centred`);
        assert.ok(Math.abs(layout.title.y - baseline.title.y) < 1, `${label}: title position stable`);
        assert.ok(Math.abs(layout.button.cy - baseline.button.cy) < 1, `${label}: Start position stable`);
        const titleInset = viewport.width < 768 ? 61 : 25;
        assert.ok(layout.title.y - layout.frame.y <= titleInset && layout.title.y >= layout.frame.y, `${label}: title stays at top with utility clearance`);
        assert.equal(await page.locator('.player-intro-frame .stage-empty').count(), 0);
        if (image !== 'none') assert.equal(await page.locator('.player-intro-frame > img').evaluate(img => getComputedStyle(img).objectFit), 'contain');
        if (music) {
          const toggle = page.locator('.player-intro-utilities .theater-utilities-toggle');
          const utility = await toggle.boundingBox();
          assert.ok(utility.x - layout.frame.x <= 25 && utility.y - layout.frame.y <= 25, `${label}: Utilities stays in the upper-left corner`);
          assert.ok(utility.x + utility.width <= layout.title.x || utility.y + utility.height <= layout.title.y, `${label}: Utilities cannot overlap the title`);
          await toggle.click();
          const open = await readLayout();
          assert.deepEqual(open, layout, `${label}: music panel never shifts title or Start`);
          const panel = page.locator('.player-intro-utilities .theater-utilities-panel');
          assert.equal(await panel.isVisible(), true);
          const box = await panel.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.y >= 0 && box.y + box.height <= viewport.height + 1, `${label}: music panel stays in viewport`);
          await panel.locator('.theater-icon-button').click();
        }
        if (shots && image === 'landscape' && music && !bubble) await page.screenshot({ path: `${shots}/intro-${locale}-${viewport.width}.png` });
        await start.focus();
        assert.equal(await start.evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('.stage--intro'));
        assert.equal(await start.count(), 0, `${label}: keyboard Start enters story`);
      }
      const scrollToStart = async () => {
        const reachable = () => start.evaluate(el => {
          const r = el.getBoundingClientRect();
          const frame = el.closest('.player-intro-frame').getBoundingClientRect();
          return r.top >= frame.top && r.bottom <= Math.min(frame.bottom, innerHeight)
            && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        });
        const cdp = viewport.width === 320 ? await context.newCDPSession(page) : null;
        try {
          for (let attempt = 0; attempt < 20 && !await reachable(); attempt++) {
            const { frame } = await readLayout();
            if (cdp) {
              const y = Math.min(frame.y + frame.h - 20, viewport.height - 20);
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: frame.cx, y }] });
              for (let step = 1; step <= 8; step++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: frame.cx, y: y - step * 20 }] });
                await page.waitForTimeout(16);
              }
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } else {
              await page.mouse.move(frame.cx, frame.cy);
              await page.mouse.wheel(0, 500);
            }
            await page.waitForTimeout(150);
          }
          assert.equal(await reachable(), true, 'Start must be reachable by real wheel/touch scrolling before clicking');
        } finally { await cdp?.detach(); }
      };
      for (const longTitle of ['茶'.repeat(40), (locale === 'en' ? 'Averylongunbrokentitle' : '一個很長的故事名稱').repeat(18)]) {
        await importAndPlay({ title: longTitle, image: 'portrait', music: true, bubble: true });
        const long = await readLayout();
        assert.equal(await page.locator('.player-intro-title').textContent(), longTitle);
        assert.ok(long.title.x >= long.frame.x && long.title.x + long.title.w <= long.frame.x + long.frame.w + 1, 'long title wraps inside frame');
        assert.ok(long.title.y + long.title.h + 8 <= long.button.y, 'long title cannot overlap Start');
        await scrollToStart();
        if (shots) await page.screenshot({ path: `${shots}/intro-scroll-${locale}-${viewport.width}-${Array.from(longTitle).length}.png` });
        await start.click();
        await page.waitForFunction(() => !document.querySelector('.stage--intro'));
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale} ${viewport.width}x${viewport.height}: 12 image/music/bubble combinations, stable title/Start, music popover, keyboard playback and long-title fallback`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
