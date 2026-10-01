import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'autosave-fixture' }, items: [] } } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(base + '/server/roleplayscene/index.html');
  const title = page.locator('[data-focus-key="project-title"]');
  await title.fill('Saved baseline'); await title.blur(); await page.waitForTimeout(650);
  await title.fill('Latest edit'); await title.blur(); await page.reload();
  await title.waitFor(); assert.equal(await title.inputValue(), 'Latest edit');
  await context.close();

  const fixture = await browser.newContext();
  await fixture.route('**/autosave-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Autosave fixture</title>' }));
  const testPage = await fixture.newPage();
  testPage.on('pageerror', error => errors.push(error.message));
  await testPage.goto(base + '/autosave-fixture');
  const result = await testPage.evaluate(async () => {
    const { Store } = await import('/server/roleplayscene/scripts/state.js');
    const { setupPersistence } = await import('/server/roleplayscene/scripts/storage.js');
    const store = new Store(), notices = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const edit = title => store.set({ project: { ...store.get().project, meta: { title, version: 1 } } });
    let cleanup = await setupPersistence(store, { showMessage: m => notices.push(m) });
    edit('Cleanup flush'); cleanup(); cleanup();
    const reopened = new Store(); let close = await setupPersistence(reopened);
    const cleanupTitle = reopened.get().project.meta.title; close();
    cleanup = await setupPersistence(store, { showMessage: m => notices.push(m) });
    edit('Pagehide flush'); window.dispatchEvent(new Event('pagehide'));
    await sleep(50);
    // A cached page keeps the subscription; more changes must still save.
    edit('After cached return');
    const warning = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(warning);
    await sleep(50);
    const settled = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(settled);
    cleanup();
    close = await setupPersistence(reopened); const latestTitle = reopened.get().project.meta.title; close();

    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = originalPut.apply(this, args);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
    try {
      cleanup = await setupPersistence(store, { showMessage: m => notices.push(m) });
      edit('Aborted write'); window.dispatchEvent(new Event('pagehide'));
      await sleep(50);
      const failedWarning = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(failedWarning);
      cleanup();
      return { cleanupTitle, latestTitle, pendingWarning: warning.defaultPrevented,
        settledWarning: settled.defaultPrevented, failedWarning: failedWarning.defaultPrevented, notices };
    } finally { IDBObjectStore.prototype.put = originalPut; }
  });
  assert.equal(result.cleanupTitle, 'Cleanup flush');
  assert.equal(result.latestTitle, 'After cached return');
  assert.equal(result.pendingWarning, true);
  assert.equal(result.settledWarning, false);
  assert.equal(result.failedWarning, true);
  assert.ok(result.notices.some(m => m.textId === 'persistence.autosaveWriteFailed'));
  assert.deepEqual(errors, []);
  console.log('PASS: immediate app reload, cleanup/pagehide flush, cached return, pending/failed save warnings and real IndexedDB transaction abort');
  await fixture.close();
} finally {
  await browser.close();
}
