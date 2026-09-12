// Native HTMLAudioElement and actual browser history navigation; no media mocks.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const upstream = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
const music = `data:audio/wav;base64,${wav.toString('base64')}`;

async function mount(music) {
  window.addEventListener('pageshow', event => { window.restoredFromCache = event.persisted; });
  const { renderPlayer } = await import('/server/roleplayscene/scripts/player/player.js');
  const NativeAudio = window.Audio;
  window.audioInstances = [];
  window.Audio = function (src) { const audio = new NativeAudio(src); window.audioInstances.push(audio); return audio; };
  const project = { meta: { title: 'Native music history' }, speakers: [], scenes: [
    { id: 'start', type: 'start', backgroundAudio: { objectUrl: music }, dialogue: [{ text: 'Start' }], choices: [] },
    { id: 'end', type: 'end', dialogue: [{ text: 'End' }], choices: [] },
  ] };
  const data = { project, audioGate: false }; const listeners = new Set();
  const store = { get: () => data, set: update => { Object.assign(data, update); for (const fn of listeners) fn(); },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  renderPlayer(store, document.querySelector('#left'), document.querySelector('#right'), () => {}, {
    initialPlaybackState: { currentSceneId: 'end', sceneHistory: ['start', 'end'], historyIndex: 1 },
  });
  window.ready = true;
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/fixture') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<link rel="stylesheet" href="/server/roleplayscene/styles/app.css"><a href="/away" id="leave">Leave</a><main id="left"></main><div id="right"></div><script type="module">(${mount.toString()})(${JSON.stringify(music)})</script>`);
    } else if (req.url === '/away') {
      res.setHeader('Content-Type', 'text/html'); res.end('<p>Away from story</p>');
    } else {
      const response = await fetch(upstream + req.url);
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'text/plain' });
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
try {
  const page = await browser.newPage(); const errors = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  cdp.on('Page.backForwardCacheNotUsed', event => console.log('Cache exclusion:', JSON.stringify(event.notRestoredExplanations)));
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin + '/away');
  await page.goto(origin + '/fixture');
  await page.waitForFunction(() => window.ready);
  let cachedReturns = 0;
  const controls = page.locator('.theater-utilities-section--music');
  for (let iteration = 0; iteration < 3; iteration++) {
    if (!await controls.isVisible()) await page.locator('.theater-utilities-toggle').click();
    assert.equal(await controls.locator('button').getAttribute('aria-pressed'), 'true');
    await controls.locator('button').click();
    await page.waitForFunction(() => window.audioInstances.at(-1)?.currentTime > 0.05 && !window.audioInstances.at(-1).paused);
    if (iteration % 2 === 0) {
      await page.locator('#leave').click();
      await page.waitForURL('**/away', { waitUntil: 'commit' });
      await page.goBack({ waitUntil: 'commit' });
    } else {
      await page.goBack({ waitUntil: 'commit' });
      await page.waitForURL('**/away', { waitUntil: 'commit' });
      await page.goForward({ waitUntil: 'commit' });
    }
    await page.waitForFunction(() => window.ready);
    if (await page.evaluate(() => window.restoredFromCache)) cachedReturns++;
    if (!await controls.isVisible()) await page.locator('.theater-utilities-toggle').click();
    assert.equal(await controls.locator('button').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.audioInstances.every(audio => audio.paused)), true);
  }
  assert.deepEqual(errors, []);
  assert.ok(cachedReturns > 0, 'Must exercise a real back/forward-cache restoration');
  console.log(`PASS: native audio activation and 3 real Back/Forward navigations (${cachedReturns} back/forward-cache restores); no page errors`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
