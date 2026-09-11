// Real streamed HTTP downloads; isolated browser storage and synthetic API data only.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createStoredZip } from '../server/editor/zip-utils.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const zip = Buffer.from(createStoredZip([
  { path: 'manifest.json', data: JSON.stringify({ format: 'worksheet-package', packageVersion: 1, assets: [] }) },
  { path: 'content/worksheet.json', data: JSON.stringify({ title: 'Progress fixture', blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Fixture question' }, responseConfig: { inputType: 'text', maxLength: 200 } }] }) },
  { path: 'padding.bin', data: new Uint8Array(65536) },
]));
let pending;
let mode = 'known';
let requests = 0;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
  if (path.endsWith('/session')) return json({ user: { sub: 'fixture', name: 'Test learner' } });
  if (path.endsWith('/published')) return json({ items: ['fixture', 'second'].map(id => ({ published_package_id: id, title: 'Worksheet ' + id, subject: 'Practice' })), hasMore: false });
  if (path.endsWith('/artifact')) {
    requests++;
    pending = {
      first() {
        res.setHeader('Content-Type', 'application/zip');
        if (mode === 'known') res.setHeader('Content-Length', zip.length);
        res.write(mode === 'invalid' ? Buffer.from('invalid ZIP') : zip.subarray(0, Math.ceil(zip.length / 2)));
      },
      finish() { res.end(mode === 'invalid' ? undefined : zip.subarray(Math.ceil(zip.length / 2))); },
    };
    return;
  }
  if (path.startsWith('/api/')) return json({ items: [] });
  if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
  try {
    const file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Outside root');
    const bytes = await readFile(file);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/server/viewer/index.html`;
const browser = await chromium.launch({ headless: true });
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) for (const entry of ['browse', 'direct']) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    mode = 'known'; pending = null;
    await page.goto(base + (entry === 'direct' ? '?publishedPackageId=fixture' : ''));
    if (entry === 'browse') {
      await page.getByRole('button', { name: locale === 'en' ? 'Browse published worksheets' : '瀏覽已發布工作紙', exact: true }).click();
      await page.locator('.viewer-package-load-button').first().click();
    }
    const label = entry === 'browse' ? page.locator('.viewer-package-load-button').first() : page.locator('.viewer-package-load-status');
    await page.waitForFunction(() => document.body.innerText.includes('Downloading') || document.body.innerText.includes('下載中'));
    assert.ok(pending);
    const before = requests;
    if (entry === 'browse') {
      assert.equal(await page.locator('.viewer-package-load-button').nth(1).isDisabled(), true);
      assert.equal(await page.locator('.viewer-package-load-button').first().isDisabled(), true);
    }
    const rect = await label.boundingBox();
    pending.first();
    await page.waitForFunction(() => document.body.innerText.includes('50%'));
    assert.match(await label.innerText(), /50%/);
    assert.equal((await label.boundingBox()).width, rect.width);
    if (shots) await page.screenshot({ path: `${shots}/package-${entry}-${locale}-${width}.png` });
    const surface = entry === 'browse' ? page.locator('.browse-modal') : page.locator('.viewer-package-loading');
    assert.equal(await surface.evaluate(e => e.getBoundingClientRect().right <= innerWidth && e.scrollWidth <= e.clientWidth), true);
    assert.equal(requests, before);
    pending.finish();
    await page.locator('.question-card').waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Missing length stays indeterminate; invalid ZIP restores an explicit retry.
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: 'Browse published worksheets', exact: true }).click();
  for (const currentMode of ['invalid', 'unknown']) {
    mode = currentMode; pending = null;
    await page.locator('.viewer-package-load-button').first().click();
    await page.waitForFunction(() => document.body.innerText.includes('Downloading'));
    pending.first();
    assert.equal(await page.locator('.viewer-package-load-button').first().innerText(), 'Downloading…');
    pending.finish();
    if (mode === 'invalid') {
      await page.locator('.published-result-row [role="alert"]:visible').waitFor();
      assert.equal(await page.locator('.viewer-package-load-button').first().isEnabled(), true);
    } else await page.locator('.question-card').waitFor();
  }
  await page.goto(base);
  const browse = page.getByRole('button', { name: 'Browse published worksheets', exact: true });
  await browse.click();
  mode = 'known'; pending = null;
  await page.locator('.viewer-package-load-button').first().click();
  await page.waitForFunction(() => document.body.innerText.includes('Downloading'));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await browse.evaluate(e => e === document.activeElement), true);
  pending.first();
  pending.finish();
  await page.locator('.question-card').waitFor();
  assert.equal(await page.locator('.browse-modal').count(), 0);
  console.log('PASS: streamed progress, both entries/locales/widths, loading surfaces fit viewport, no unexpected console errors, concurrent load prevention, unknown size, invalid ZIP retry and close/focus behavior');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
