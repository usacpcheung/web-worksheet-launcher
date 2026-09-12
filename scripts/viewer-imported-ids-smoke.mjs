// Imported IDs must not be mistaken for inherited recovery or message entries.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: {
    ok: true, data: { user: { sub: 'fixture', name: 'Test learner' }, items: [] },
  } }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia() {} }, configurable: true });
    window.MediaRecorder = class { static isTypeSupported() { return true; } };
  });
  await page.goto(base + '/server/viewer/index.html');
  for (const locale of ['en', 'zh-Hant']) for (const id of ['constructor', 'toString', '__proto__']) {
    await page.evaluate(async ({ id, locale }) => {
      localStorage.setItem('worksheetLauncher.locale', locale);
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      const now = new Date().toISOString();
      await viewerStorage.attempts.put({ localId: 'imported-ids', localAttemptId: 'imported-ids',
        status: 'in_progress', startedAt: now, lastActiveBlockId: id, lastActiveIndex: 0,
        viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', snapshotVersion: 1,
          title: 'Imported question', blocks: [{ blockId: id, kind: 'question', position: 0,
            prompt: { text: 'Describe your answer.' }, responseConfig: { inputType: 'text', maxLength: 200 } }] },
        answers: { [id]: { value: 'Original answer', answeredAt: now } },
        metadata: { localId: 'imported-ids', origin: 'local_source', updatedAt: now } });
    }, { id, locale });
    await page.goto(base + '/server/viewer/index.html?localAttemptId=imported-ids');
    await page.locator('.question-card__rewrite-btn').waitFor();
    assert.equal(await page.locator('.question-card__rewrite-btn').isEnabled(), true);
    assert.equal(await page.locator('.question-card__voice-btn').isEnabled(), true);
    assert.equal(await page.locator('.viewer-voice-recovery').isVisible(), false);
    assert.equal(await page.locator('.question-card > textarea:not(.question-card__review-status)').inputValue(), 'Original answer');
    assert.equal((await page.locator('.question-card').innerText()).includes('[native code]'), false);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: reserved imported question IDs keep answer, voice and rewrite available without false recovery in both locales');
} finally { await browser.close(); }
