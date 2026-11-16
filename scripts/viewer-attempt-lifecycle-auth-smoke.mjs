import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createWorksheetPackageFromDraft } from '../server/editor/worksheet-package.js';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const bytes = createWorksheetPackageFromDraft({ localId: 'published-b', title: 'Published B', blocks: [{ blockId: 'q', kind: 'question', position: 0, prompt: { text: 'Question B' }, responseConfig: { inputType: 'text' } }] }).bytes;
const browser = await chromium.launch();
try {
 for (const { changed, recovery } of [{ changed: false, recovery: 'popup' }, { changed: true, recovery: 'popup' }, { changed: false, recovery: 'same-tab' }]) {
  const context = await browser.newContext();
  try {
    let signedIn = false, artifactStarted, releaseArtifact;
    const artifactBegan = new Promise(resolve => { artifactStarted = resolve; });
    const waitArtifact = new Promise(resolve => { releaseArtifact = resolve; });
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/session')) return route.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? { ok: true, data: { ready: true, user: { sub: 'qa' } } } : { ok: false, error: { code: 'AUTH_REQUIRED', requiresSignIn: true } } });
      artifactStarted(); await waitArtifact;
      return route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from(bytes) });
    });
    await context.route('**/qa-login', async route => { signedIn = true; await route.fulfill({ json: { ok: true } }); });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(`${base}/server/viewer/`);
    await page.evaluate(async () => {
      const { viewerStorage: s } = await import('/server/viewer/storage/index.js');
      const now = new Date().toISOString();
      await s.attempts.put({ localId: 'a', localAttemptId: 'a', runtimeMode: 'normal', status: 'in_progress', startedAt: now,
        viewerPayload: { worksheetId: 'a', snapshotId: 's', snapshotVersion: 1, title: 'Keep A', blocks: [{ blockId: 'q', kind: 'question', prompt: { text: 'Question A' }, responseConfig: { inputType: 'text' } }] },
        answers: { q: { value: 'A answer' } }, metadata: { localId: 'a', origin: 'local_source', updatedAt: now } });
      s.resumeFlags.set('viewer:lastSession', { localId: 'a', store: 'localAttempts' });
    });
    await page.goto(`${base}/server/viewer/?publishedPackageId=published-b`);
    await page.locator('.read-auth-prompt').waitFor();
    assert.match(await page.locator('.read-auth-context-warning').textContent(), /replace your current local attempt/);
    assert.equal(await page.locator('.viewer-attempt-dialog').count(), 0);
    if (recovery === 'popup') await page.evaluate(async () => {
      const { ViewerAttemptSession } = await import('/server/viewer/main.js');
      ViewerAttemptSession.prototype.beginServerSignIn = async () => { await fetch('/qa-login'); return { ok: true }; };
    });
    if (recovery === 'same-tab') await page.evaluate(() => { window.open = () => null; });
    await page.locator('.read-auth-prompt button').last().click();
    if (recovery === 'same-tab') {
      const label = await page.evaluate(async () => (await import('/server/app/i18n/index.js')).t('readAuth.sameTab'));
      const action = page.locator('.read-auth-prompt').getByRole('button', { name: label, exact: true });
      await action.waitFor(); signedIn = true;
      await Promise.all([page.waitForNavigation(), action.click()]);
    }
    await artifactBegan;
    // Login succeeded, but downloading has not: A remains intact and selected.
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('worksheetLauncher:resumeFlags'))['viewer:lastSession'].localId), 'a');
    if (changed) await page.evaluate(async () => {
      const { viewerStorage: s } = await import('/server/viewer/storage/index.js');
      const a = await s.attempts.get('a'); a.answers.q.value = 'Changed during login'; await s.attempts.put(a);
    });
    releaseArtifact();
    if (changed) {
      await page.locator('.viewer-attempt-dialog').waitFor();
      await page.locator('.viewer-attempt-dialog button[type=button]').click();
      await page.locator('.viewer-resume-card').waitFor();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('worksheetLauncher:resumeFlags'))['viewer:lastSession'].localId), 'a');
      assert.equal(await page.evaluate(async () => (await (await import('/server/viewer/storage/index.js')).viewerStorage.attempts.get('a')).answers.q.value), 'Changed during login');
    } else {
      await page.waitForFunction(() => window.viewerSession?.state.viewerPayload?.title === 'Published B');
      assert.equal(await page.locator('.viewer-attempt-dialog').count(), 0, 'unchanged consent must not produce a second confirmation');
    }
    console.log(`PASS combined login warning: login preserves A; changed-during-load=${changed}, recovery=${recovery}`);
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
