// Real local persistence/package/preview flow; no server records or providers.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
// Existing package import adds an empty options list to blank configurations.
// It is not a word bank; compare all authored fields without that unused default.
const comparableConfig = config => {
  const result = structuredClone(config);
  if (result?.inputType === 'fill_in_blanks' && Array.isArray(result.options) && result.options.length === 0) delete result.options;
  return result;
};
const comparableBlocks = blocks => blocks.map(block => block.kind === 'question'
  ? { ...block, responseConfig: comparableConfig(block.responseConfig) } : block);
const browser = await chromium.launch();
try {
  for (const [locale, width] of [['en', 1280], ['zh-Hant', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
      await context.route(url => url.pathname.startsWith('/api/'), route => {
        if (route.request().method() !== 'GET') writes.push(route.request().url());
        return route.fulfill({ status: 401, json: { ok: false, error: { code: 'AUTH_REQUIRED' } } });
      });
      await page.goto(`${base}/server/editor/`);
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(async () => {
        const s = window.editorSession;
        const blank = (mode, checking = 'auto') => ({ inputType: 'fill_in_blanks', mode, reuseWords: false, distractors: mode === 'word_bank' ? ['stone'] : [],
          passage: { version: 1, blocks: [{ tag: 'p', children: [
            { tag: 'text', text: 'Water 水: ' },
            { tag: 'blank', id: 'b1', text: checking === 'auto' ? 'water' : '', alternatives: [], checking },
          ] }] },
        });
        const configs = [
          { inputType: 'text', textMode: 'standard', maxLength: 1200, displayMode: 'single_line' },
          { inputType: 'text', textMode: 'long', maxLength: 20000, displayMode: 'multi_line' },
          { inputType: 'number', min: -2, max: 5, correctAnswer: 0, numberRules: { allowSigned: true, decimalPlacesAllowed: 2 } },
          { inputType: 'boolean', correctAnswer: false },
          // Legacy value-based answer keys must acquire the right stable editor IDs.
          { inputType: 'multiple_choice', selectionMode: 'single', options: ['A', 'B'], correctAnswer: 'B' },
          { inputType: 'multiple_choice', selectionMode: 'multi', options: [{ id: 'x', value: 'X', label: 'X' }, { id: 'y', value: 'Y', label: 'Y' }], correctAnswerOptionIds: ['y', 'x'] },
          { inputType: 'image_response', maxImages: 3 },
          blank('typed', 'free'), blank('word_bank'),
        ];
        s.state.draft.blocks = [{ blockId: 'reading', kind: 'content', position: 0, content: { text: 'Mixed worksheet 混合工作紙', format: 'plain_text' } },
          ...configs.map((responseConfig, index) => ({ blockId: `q${index}`, kind: 'question', position: index + 1,
            prompt: { text: `Question 題目 ${index + 1}`, format: 'plain_text' }, responseConfig }))];
        s.state.selectedBlockId = 'q0';
        s.updateTitle('Configuration round trip 設定測試');
        await s.saveNow();
      });
      const snapshot = () => page.evaluate(() => window.editorSession.state.draft.blocks);
      // Legacy records are normalized on opening, not by overwriting the editable
      // state during autosave. Save the migrated editor IDs before checking reload.
      await page.reload();
      await page.waitForFunction(() => window.editorSession);
      await page.evaluate(() => window.editorSession.saveNow());
      const saved = await snapshot();
      await page.reload();
      await page.waitForFunction(() => window.editorSession);
      assert.deepEqual(await snapshot(), saved, 'save/reload retains IDs, types and settings');
      const exported = await page.evaluate(async () => {
        const s = window.editorSession;
        const { parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
        const bytes = await s.buildCurrentDraftPackageZipBytes();
        return { bytes: Array.from(bytes), blocks: parseWorksheetPackage(bytes).worksheet.blocks };
      });
      const imported = await page.evaluate(async bytes => {
        const s = window.editorSession;
        await s.importWorksheetPackageFile(new File([new Uint8Array(bytes)], 'mixed.zip', { type: 'application/zip' }), { convertToEditableDraft: true });
        await s.saveNow();
        return s.state.draft.blocks;
      }, exported.bytes);
      const configurations = blocks => Object.fromEntries(blocks.filter(block => block.kind === 'question').map(block => [block.blockId, block.responseConfig]));
      const config = configurations(imported);
      assert.equal(config.q0.maxLength, 1200);
      assert.equal(config.q0.displayMode, 'single_line');
      assert.equal(config.q1.maxLength, 20000);
      assert.equal(config.q1.textMode, 'long');
      assert.equal(config.q2.correctAnswer, 0);
      assert.equal(config.q2.numberRules.decimalPlacesAllowed, 2);
      assert.equal(config.q3.correctAnswer, false);
      assert.equal(config.q4.options.find(option => option.id === config.q4.correctAnswerOptionId).value, 'B');
      assert.deepEqual(config.q5.correctAnswerOptionIds.map(id => config.q5.options.find(option => option.id === id).value), ['Y', 'X']);
      assert.equal(config.q6.maxImages, 3);
      assert.deepEqual(comparableConfig(config.q7), configurations(saved).q7);
      assert.deepEqual(comparableConfig(config.q8), configurations(saved).q8);
      // Re-export must retain package semantics even if legacy import assigned IDs.
      const reexported = await page.evaluate(async () => {
        const { parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
        return parseWorksheetPackage(await window.editorSession.buildCurrentDraftPackageZipBytes()).worksheet.blocks;
      });
      assert.deepEqual(comparableBlocks(reexported), comparableBlocks(exported.blocks));
      await page.reload();
      await page.waitForFunction(() => window.editorSession);
      assert.deepEqual(await snapshot(), imported);
      const previewLabel = await page.evaluate(async () => (await import('/server/app/i18n/index.js')).t('editor.actions.openViewer'));
      await page.getByRole('button', { name: previewLabel, exact: true }).click();
      await page.waitForFunction(() => window.viewerSession?.state.viewerPayload?.blocks?.length === 10);
      assert.equal(new URL(page.url()).searchParams.get('preview'), '1');
      const preview = await page.evaluate(() => window.viewerSession.state.viewerPayload.blocks);
      const previewConfig = configurations(preview);
      assert.equal(previewConfig.q2.correctAnswer, 0);
      assert.equal(previewConfig.q3.correctAnswer, false);
      assert.equal(previewConfig.q4.correctAnswer, 'B');
      assert.deepEqual(previewConfig.q5.correctAnswer, ['Y', 'X']);
      assert.deepEqual(preview.map(block => block.blockId), imported.map(block => block.blockId));
      assert.equal(await page.locator('.question-card').count(), 9);
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      console.log(`PASS ${locale}/${width}: mixed configurations, legacy keys, reload, ZIP round trip and preview`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
