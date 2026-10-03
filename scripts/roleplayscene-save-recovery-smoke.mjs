import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  let mode = 'slot', deleted = false, uploads = 0;
  let heldList = null, holdList = false, listArrived;
  const listPending = new Promise(resolve => { listArrived = resolve; });
  const draft = { roleplayscene_uploaded_draft_id: 'fixture', title: 'Fixture' };
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    if (holdList && path.endsWith('/roleplayscene/drafts') && route.request().method() === 'GET') {
      heldList = route;
      listArrived();
      return;
    }
    if (path.endsWith('/drafts/upload')) {
      uploads++;
      if (mode === 'gateway') return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' });
      if (!deleted) return route.fulfill({ status: 409, json: { ok: false, error: {
        code: 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED', details: { slotLimit: 1, uploadedDrafts: [draft] },
      } } });
    }
    if (route.request().method() === 'DELETE') deleted = true;
    return route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [draft] } } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/server/roleplayscene/index.html');
  const save = page.locator('#server-save-btn');
  for (const action of ['cancel', 'close', 'success']) {
    await save.click();
    await page.locator('[data-draft-action="delete"]').click();
    if (action === 'cancel') await page.locator('#server-modal-actions button').last().click();
    else if (action === 'close') await page.locator('#server-modal-close').click();
    else await page.locator('#server-modal-actions .server-danger-action').click();
    await page.waitForFunction(() => !document.querySelector('#server-save-btn').disabled);
    assert.equal(uploads, action === 'cancel' ? 1 : action === 'close' ? 2 : 4);
  }
  mode = 'gateway';
  await save.click();
  await page.waitForFunction(() => !document.querySelector('#server-save-btn').disabled);
  assert.equal(await page.locator('#server-signin-btn').isHidden(), true);
  mode = 'slot'; deleted = false;
  await save.click();
  holdList = true;
  await page.locator('.uploaded-drafts-refresh-action').click();
  await listPending;
  await page.locator('#server-modal-close').click();
  await page.waitForFunction(() => !document.querySelector('#server-save-btn').disabled);
  await save.click();
  await page.locator('[data-draft-action="delete"]').click();
  const confirmation = await page.locator('#server-modal-title').textContent();
  holdList = false;
  await heldList.fulfill({ json: { ok: true, data: { items: [draft] } } });
  await page.waitForFunction(() => !document.querySelector('#server-manage-btn').disabled);
  assert.equal(await page.locator('#server-modal-title').textContent(), confirmation);
  assert.equal(await page.locator('#server-modal-actions .server-danger-action').count(), 1);
  await page.locator('#server-modal-close').click();
  assert.deepEqual(errors, []);
  console.log('PASS: slot-recovery cancellation/retry, HTML 502, and late Refresh preserves newer confirmation');
  await context.close();
} finally { await browser.close(); }
