import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
    await page.goto(base + '/server/editor/index.html');
    await page.waitForFunction(() => window.editorSession);
    await page.evaluate(async locale => { (await import('/server/app/i18n/index.js')).setLocale(locale); }, locale);
    await page.reload();
    await page.waitForFunction(() => window.editorSession);
    const field = page.locator('#editor-block-editor');
    const toggle = page.locator('.editor-text-preview-toggle');
    const preview = page.locator('.editor-text-preview');
    await field.fill(''); await toggle.click();
    assert.equal(await preview.innerText(), locale === 'en' ? 'Nothing to preview' : '沒有內容可預覽');
    await toggle.click();
    const source = '## Lesson\n- **重要**\n- *Second*\n\nLine one\nLine two\n<script>window.injected=true</script>\n![image](https://example.invalid/a.png)';
    await field.fill(source);
    await field.evaluate(el => el.setSelectionRange(3, 9));
    await toggle.click();
    assert.equal(await preview.locator('h2').innerText(), 'Lesson');
    assert.equal(await preview.locator('strong').innerText(), '重要');
    assert.equal(await preview.locator('script,img,a').count(), 0);
    await page.evaluate(() => window.editorSession.saveNow());
    assert.equal(await preview.isVisible(), true, 'Autosave preserves preview');
    const previewHtml = await preview.innerHTML();
    await page.locator('.editor-text-help summary').click();
    const helpBox = await page.locator('.editor-text-help-popover').boundingBox();
    assert.ok(helpBox.x >= 0 && helpBox.x + helpBox.width <= width + 1);
    if (shots) await page.screenshot({ path: `${shots}/markdown-help-${locale}-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.editor-text-help').evaluate(el => el.open), false);
    await toggle.click();
    assert.deepEqual(await field.evaluate(el => [el.selectionStart, el.selectionEnd, el === document.activeElement]), [3, 9, true]);
    assert.equal(await field.inputValue(), source);
    await page.evaluate(() => { window.editorSession.createBlock('question'); window.editorSession.notifyStateChange(); });
    await field.fill('### Question\n**Explain** your answer.');
    await toggle.click();
    assert.equal(await preview.locator('h3').innerText(), 'Question');
    assert.equal(await page.evaluate(() => window.injected), undefined);
    if (shots) await page.screenshot({ path: `${shots}/markdown-editor-${locale}-${width}.png`, fullPage: true });
    const payload = await page.evaluate(async () => {
      const { createWorksheetPackageFromDraft, parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
      const session = window.editorSession;
      const draft = await session.saveNow();
      const output = createWorksheetPackageFromDraft(draft);
      if (output.manifest.packageVersion !== 3) throw new Error('Expected Markdown package version');
      return { worksheetId: 'md-w', snapshotId: 'md-s', snapshotVersion: 1, title: '**Literal title**', blocks: parseWorksheetPackage(output.bytes).worksheet.blocks };
    });
    await page.goto(base + '/server/viewer/index.html');
    await page.evaluate(async ({ payload, locale }) => {
      (await import('/server/app/i18n/index.js')).setLocale(locale);
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      await viewerStorage.attempts.put({ localId: 'md-attempt', localAttemptId: 'md-attempt', status: 'in_progress', startedAt: new Date().toISOString(),
        lastActiveBlockId: payload.blocks[0].blockId, lastActiveIndex: 0, viewerPayload: payload, answers: {}, metadata: { localId: 'md-attempt', origin: 'local_source', updatedAt: new Date().toISOString() } });
    }, { payload, locale });
    await page.goto(base + '/server/viewer/index.html?localAttemptId=md-attempt');
    await page.locator('.content-card h2').waitFor();
    assert.equal(await page.locator('.content-card').innerHTML(), previewHtml, 'Viewer and editor share exact renderer output');
    const nextLabel = await page.evaluate(async () => (await import('/server/app/i18n/index.js')).t('viewer.actions.nextBlock'));
    await page.getByRole('button', { name: nextLabel, exact: true }).click();
    await page.locator('.question-card__prompt-label h3').waitFor();
    await page.locator('.question-card > textarea:not(.question-card__review-status)').fill('**Literal learner answer**');
    await page.evaluate(() => window.viewerSession.completeLocalAttempt());
    // Session completion notifies state; the prompt stays formatted and the answer stays literal.
    await page.waitForFunction(() => window.viewerSession.state.status === 'completed');
    assert.equal(await page.locator('.question-card__prompt-label strong').innerText(), 'Explain');
    const html = await page.evaluate(async () => {
      const { buildWorksheetPrintReportModel, buildWorksheetPrintReportHtml } = await import('/server/viewer/main.js');
      const session = window.viewerSession;
      return buildWorksheetPrintReportHtml(await buildWorksheetPrintReportModel({ viewerPayload: session.state.viewerPayload, answers: session.state.answers }));
    });
    assert.ok(html.includes('<h3>Question</h3>') && html.includes('**Literal learner answer**'));
    const printPage = await context.newPage();
    // Keep the generated print page open for inspection after its normal print callback.
    await printPage.evaluate(() => { window.print = () => {}; window.close = () => {}; });
    await printPage.setContent(html);
    await printPage.emulateMedia({ media: 'print' });
    assert.equal(await printPage.locator('.print-question-text h3').innerText(), 'Question');
    if (shots) await printPage.screenshot({ path: `${shots}/markdown-print-${locale}-${width}.png`, fullPage: true });
    await printPage.close();
    if (shots) await page.screenshot({ path: `${shots}/markdown-viewer-${locale}-${width}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.goto(base + '/server/editor/index.html');
    await page.waitForFunction(() => window.editorSession);
    const legacy = '**literal**\n- point\n## title\n\\*star\\*';
    const imported = await page.evaluate(async text => {
      const { createWorksheetPackageFromDraft } = await import('/server/editor/worksheet-package.js');
      const { worksheetTextToPlain } = await import('/server/app/worksheet-text.js');
      const original = createWorksheetPackageFromDraft({ localId: 'legacy', title: 'Legacy', blocks: [{ blockId: 'c', kind: 'content', content: { text, format: 'plain_text' } }] });
      const result = await window.editorSession.importWorksheetPackageFile(new File([original.bytes], 'legacy.zip'), { convertToEditableDraft: true });
      const draft = result.draftRecord;
      return { format: draft.blocks[0].content.format, visibleText: worksheetTextToPlain(draft.blocks[0].content),
        original: result.importedRecord, version: createWorksheetPackageFromDraft(draft).manifest.packageVersion,
        notices: window.editorSession.state.notifications.filter(item => item.source === 'formatting.converted').length };
    }, legacy);
    assert.equal(imported.format, 'limited-markdown-v1'); assert.equal(imported.version, 3);
    assert.equal(imported.visibleText, legacy); assert.equal(imported.notices, 1);
    assert.ok(JSON.stringify(imported.original).includes('plain_text'), 'Retained import is still plain text');
    await toggle.click();
    assert.equal(await preview.locator('strong,em,h2,ul').count(), 0, 'Converted source keeps literal appearance');
    await toggle.click();
    await field.fill('## Long content\n' + 'longword'.repeat(500) + '\n- end');
    await toggle.click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS: Markdown editor preview, source/selection retention, help keyboard, package round trip, viewer/review/print, both languages and widths');
} finally { await browser.close(); }
