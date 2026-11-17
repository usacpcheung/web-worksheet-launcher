import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const browser = await chromium.launch();
try {
 for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
   await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
   await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { items: [] } } }));
   const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(12000);
   await page.goto(`${process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765'}/server/editor/`);
   await page.waitForFunction(() => window.editorSession);
   await page.evaluate(async () => {
    const s = window.editorSession;
    s.state.draft.title = 'Status review';
    s.state.draft.blocks = [{ blockId: 'empty-reading', position: 0, kind: 'content', content: { text: '' } },
     { blockId: 'mc', position: 1, kind: 'question', prompt: { text: 'Choose a colour', format: 'plain_text' }, responseConfig: { inputType: 'multiple_choice', selectionMode: 'single', options: [{ id: 'a', value: 'Blue', label: 'Blue' }, { id: 'b', value: 'Blue', label: 'Blue' }] } }];
    const { createFeedbackConfig } = await import('/server/app/worksheet-feedback.js');
    s.state.draft.feedback = createFeedbackConfig(); s.state.draft.feedback.enabled = true;
    s.selectBlock('mc'); s.touchDraft(); await s.autosave(); clearTimeout(s.autosaveTimer); s.notifyStateChange();
   });
   const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
   const badge = page.locator('.editor-status-badge'), modal = page.locator('.editor-status-dialog');
   const layout = () => page.locator('.editor-layout').evaluate(el => ({ top: el.getBoundingClientRect().top, width: el.getBoundingClientRect().width, scroll: scrollY }));
   const before = await layout(); await badge.click();
   assert.deepEqual(await layout(), before, 'opening status does not shift editor');
   assert.equal(await modal.locator('.editor-status-issue').count(), 3);
   assert.equal(await modal.getByRole('button', { name: await label('editorStatus.goBlock'), exact: true }).count(), 2);
   await modal.locator('.editor-status-close').press('Shift+Tab');
   assert.equal(await modal.locator('button').last().evaluate(el => el === document.activeElement), true);
   await page.keyboard.press('Escape'); assert.deepEqual(await layout(), before);
   assert.equal(await badge.evaluate(el => el === document.activeElement), true);
   await page.locator('.editor-status-info').click();
   assert.equal(await modal.locator('.editor-status-id').inputValue(), await page.evaluate(() => window.editorSession.state.draft.localId));
   await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
   await modal.getByRole('button', { name: await label('editorStatus.copyId'), exact: true }).click();
   await modal.getByText(await label('editorStatus.copyFallback'), { exact: true }).waitFor();
   assert.equal(await modal.locator('.editor-status-id').evaluate(el => el.selectionEnd === el.value.length), true);
   await modal.locator('.editor-status-close').click();
   await badge.click();
   await modal.getByRole('button', { name: await label('editorStatus.goBlock'), exact: true }).first().click();
   assert.equal(await page.evaluate(() => window.editorSession.state.selectedBlockId), 'empty-reading');
   assert.equal(await modal.count(), 0);
   await page.evaluate(() => window.editorSession.updateBlockContent('empty-reading', 'Now readable'));
   await badge.click();
   assert.equal(await modal.getByRole('button', { name: await label('editorStatus.goBlock'), exact: true }).count(), 1);
   await modal.getByRole('button', { name: await label('editorStatus.goFeedback'), exact: true }).click();
   assert.equal(await page.evaluate(() => window.editorSession.state.feedbackSettingsDraftId === window.editorSession.state.draft.localId), true);
   // Actual persistence failure, then retry through the existing saveNow operation.
   await page.evaluate(async () => {
    const s = window.editorSession; clearTimeout(s.autosaveTimer);
    s.updateTitle('Unsaved revision'); clearTimeout(s.autosaveTimer);
    window.originalDraftPut = s.storage.drafts.put;
    s.storage.drafts.put = async () => { throw new Error('Quota fixture'); };
    try { await s.saveNow(); } catch { /* expected */ }
   });
   assert.equal(await badge.getAttribute('data-tone'), 'error');
   await page.evaluate(() => { const s = window.editorSession; s.pushNotification({ kind: 'success', text: 'Export complete fixture' }); s.notifyStateChange(); });
   assert.equal(await badge.getAttribute('data-tone'), 'error');
   await badge.click();
   await modal.getByText('Quota fixture', { exact: true }).waitFor();
   await page.evaluate(() => { const s = window.editorSession; s.storage.drafts.put = window.originalDraftPut; });
   await modal.getByRole('button', { name: await label('editorStatus.retrySave'), exact: true }).click();
   await page.waitForFunction(() => !window.editorSession.state.lastPersistenceError);
   assert.equal(await modal.count(), 1);
   if (process.env.VIEWER_SMOKE_SCREENSHOTS) { await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.VIEWER_SMOKE_SCREENSHOTS, `status-${locale}-${width}.png`) }); }
   // A refresh does not replace unchanged dialog controls or reset scroll/focus.
   await modal.locator('.editor-status-close').evaluate(el => { window.sameClose = el; });
   await page.evaluate(() => window.editorSession.notifyStateChange());
   assert.equal(await modal.locator('.editor-status-close').evaluate(el => el === window.sameClose), true);
   // Replacing the same draft closes the dialog; retained controls cannot navigate later.
   const stale = await modal.getByRole('button', { name: await label('editorStatus.goBlock'), exact: true }).first().elementHandle();
   await page.evaluate(async () => { const s = window.editorSession; await s.createOrOpenByLocalDraftId(s.state.draft.localId); s.notifyStateChange(); });
   assert.equal(await modal.count(), 0); const selected = await page.evaluate(() => window.editorSession.state.selectedBlockId);
   await stale.evaluate(el => el.click()); assert.equal(await page.evaluate(() => window.editorSession.state.selectedBlockId), selected);
   await badge.click();
   await page.locator('.language-selector select').evaluate((el, locale) => { el.value = locale === 'en' ? 'zh-Hant' : 'en'; el.dispatchEvent(new Event('change', { bubbles: true })); }, locale);
   assert.equal(await modal.count(), 0); assert.equal(await page.locator('.editor-shell').evaluate(el => el.inert), false);
   assert.equal(await page.evaluate(() => document.body.style.overflow), '');
   await page.evaluate(() => { const s = window.editorSession; s.selectBlock('mc'); for (let i = 0; i < 4; i++) s.pushNotification({ kind: 'success', text: `Import/export notification ${i}: 工作紙套件已完成匯入及匯出。`, ttlMs: 10000 }); s.notifyStateChange(); });
   assert.equal(await page.locator('.notification-toast').count(), 1);
   const top = await page.locator('.editor-topbar').boundingBox(), below = await page.locator('.editor-layout').boundingBox();
   assert.ok(top.y + top.height <= below.y);
   await page.locator('.option-add-btn').scrollIntoViewIfNeeded();
   assert.equal(await page.locator('.option-add-btn').evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true);
   await page.locator('.editor-notification-dismiss').click(); assert.equal(await page.locator('.notification-toast').count(), 0);
   await page.locator('.language-selector select').selectOption(locale);
   assert.equal(await page.locator('.notification-toast').count(), 0, 'dismissed notice does not reappear after language switch');
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
   // Imported identifiers are rendered as literal input values, never markup.
   const unsafeId = '<img src=x onerror=alert(1)>';
   await page.evaluate(id => { window.editorSession.state.draft.localId = id; window.editorSession.notifyStateChange(); }, unsafeId);
   await page.locator('.editor-status-info').click();
   assert.equal(await modal.locator('.editor-status-id').inputValue(), unsafeId);
   assert.equal(await modal.locator('img').count(), 0);
   await modal.locator('.editor-status-close').click();
   assert.deepEqual(errors, []);
   console.log(`PASS status panel ${locale}/${width}: real validation/save states, navigation, dialogs, lifecycle, notifications and layout`);
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
