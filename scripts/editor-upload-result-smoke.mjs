import { completeDefaultReadingBlock } from './editor-test-helpers.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) {
    const context = await browser.newContext({ viewport: { width: locale === 'en' ? 1280 : 390, height: 900 } });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      let mode = 'conflict', posts = [], deletions = 0;
      await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/session')) return route.fulfill({ json: { ok: true, data: { ready: true, user: { sub: 'fixture' } } } });
        if (route.request().method() === 'DELETE') {
          assert.ok(url.pathname.endsWith('/drafts/slot-fixture'));
          deletions++;
          return route.fulfill({ json: { ok: true, data: {} } });
        }
        if (route.request().method() === 'POST' && url.pathname.endsWith('/drafts/upload')) {
          const action = url.searchParams.get('conflictAction') || ''; posts.push(action);
          if (mode === 'slot-delete') return deletions
            ? route.fulfill({ status: 201, json: { ok: true, data: { uploaded_draft_id: 'fixture' } } })
            : route.fulfill({ status: 409, json: { ok: false, error: { code: 'DRAFT_SLOT_LIMIT_REACHED', details: { slotLimit: 3, uploadedDrafts: [{ uploaded_draft_id: 'slot-fixture', title: 'Disposable slot fixture' }] } } } });
          if (mode === 'slot' || (mode === 'copy-slot' && action === 'copy')) return route.fulfill({ status: 409, json: { ok: false, error: { code: 'DRAFT_SLOT_LIMIT_REACHED', details: { slotLimit: 3 } } } });
          if (action === '') return route.fulfill({ status: 409, json: { ok: false, error: { code: 'DRAFT_NAME_CONFLICT', message: 'Raw English server conflict', details: { existingDraft: { title: 'Fixture' } } } } });
          return route.fulfill({ status: 201, json: { ok: true, data: { uploaded_draft_id: 'fixture' } } });
        }
        return route.fulfill({ json: { ok: true, data: { items: [] } } });
      });
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession?.state.serverSession.status === 'ready');
      await completeDefaultReadingBlock(page);
      await page.locator('details').filter({ has: page.locator('[data-upload-cancel="editor"]') }).locator('summary').click();
      const keys = ['editor.server.uploadDraft', 'common.actions.cancel', 'editor.modal.uploadConflict.saveAsNewCopy', 'editor.modal.uploadConflict.replaceUploadedDraft', 'apiErrors.conflict'];
      const labels = await page.evaluate(async keys => {
        const { t } = await import('/server/app/i18n/index.js');
        return keys.map(key => t(key));
      }, keys);
      assert.match(labels[4], locale === 'en' ? /Review the available choices/ : /選項/);
      const upload = page.getByRole('button', { name: labels[0], exact: true });
      for (const action of ['cancel', 'replace', 'copy']) {
        posts = []; mode = 'conflict';
        await upload.click();
        await page.getByRole('dialog').waitFor();
        await page.getByText(labels[4], { exact: true }).filter({ visible: true }).first().waitFor();
        assert.equal(await page.getByText('Raw English server conflict', { exact: true }).count(), 0);
        await page.getByRole('dialog').getByRole('button', { name: labels[action === 'cancel' ? 1 : action === 'copy' ? 2 : 3], exact: true }).click();
        await page.waitForFunction(() => !window.editorSession.state.isUploadDraftFlowActive);
        assert.deepEqual(posts, action === 'cancel' ? [''] : ['', action]);
      }
      for (const scenario of ['slot', 'copy-slot']) {
        mode = scenario; posts = [];
        await upload.click();
        if (scenario === 'copy-slot') await page.getByRole('dialog').getByRole('button', { name: labels[2], exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: labels[1], exact: true }).click();
        await page.waitForFunction(() => !window.editorSession.state.isUploadDraftFlowActive);
        assert.deepEqual(posts, scenario === 'slot' ? [''] : ['', 'copy']);
      }
      // A nested confirmation must leave slot recovery open on cancel, then allow one retry after deletion.
      mode = 'slot-delete'; posts = [];
      await upload.click();
      const slot = page.locator('.browse-modal');
      await slot.locator('.published-result-row button').click();
      const confirmation = page.locator('.confirm-modal:not(.browse-modal)');
      await confirmation.locator('button').first().click();
      assert.equal(deletions, 0);
      assert.deepEqual(posts, ['']);
      await slot.locator('.published-result-row button').click();
      await confirmation.locator('button').last().click();
      await page.waitForFunction(() => !window.editorSession.state.isUploadDraftFlowActive);
      assert.equal(deletions, 1);
      assert.deepEqual(posts, ['', '']);
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log('PASS: editor conflict choices, slot cancellation and confirmed-deletion retry in both locales');
} finally { await browser.close(); }
