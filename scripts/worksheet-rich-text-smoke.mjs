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
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
    await page.goto(base + '/server/editor/index.html');
    await page.waitForFunction(() => window.editorSession);
    await page.evaluate(async locale => (await import('/server/app/i18n/index.js')).setLocale(locale), locale);
    await page.reload();
    const field = page.locator('#editor-block-editor');
    await field.fill('**literal** [[not a blank]]');
    assert.equal(await field.locator('strong').count(), 0, 'Typing Markdown stays literal');
    await field.press('ControlOrMeta+a');
    await field.evaluate(el => {
      const data = new DataTransfer();
      data.setData('text/html', '<p><u><span style="color:red">Keep red</span></u><a href="javascript:alert(1)"> link text</a><img src="x" onerror="alert(1)"></p>');
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    assert.equal(await field.locator('u span').innerText(), 'Keep red');
    assert.equal(await field.locator('img,a,script').count(), 0);
    await field.press('ControlOrMeta+a');
    await page.locator('[data-command="clear"]').click();
    assert.equal(await field.locator('u,strong,em,span[style]').count(), 0);
    const safeText = await field.innerText();
    await field.press('ControlOrMeta+a');
    await field.evaluate(el => {
      const data = new DataTransfer();
      data.setData('text/html', '<blockquote>'.repeat(40) + '<p>Too nested</p>' + '</blockquote>'.repeat(40));
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    assert.equal(await field.innerText(), safeText, 'Rejected complex paste preserves the previous document');
    assert.match(await page.locator('.editor-rich-text [role="status"]').first().innerText(), /complex|複雜/);
    await field.fill('第一段 Learning');
    const firstId = await page.evaluate(() => window.editorSession.state.selectedBlockId);
    const command = name => page.locator(`[data-command="${name}"]`).click();
    await field.press('ControlOrMeta+a');
    await command('bold'); await command('italic'); await command('underline'); await command('redText');
    assert.equal(await field.locator('strong em u span').innerText(), '第一段 Learning');
    assert.equal(await page.locator('[data-command="underline"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.editorSession.state.draft.blocks[0].content.format), 'rich-text-v1');
    await command('undo'); assert.equal(await field.locator('span[style]').count(), 0);
    await command('redo'); assert.equal(await field.locator('span[style]').count(), 1);
    await page.locator('.editor-rich-toolbar select').selectOption('2');
    assert.equal(await field.locator('h2').count(), 1);
    await page.locator('.editor-rich-toolbar select').selectOption('p');
    await command('bulletList'); assert.equal(await field.locator('ul li').count(), 1);
    await command('bulletList');
    await command('orderedList'); assert.equal(await field.locator('ol li').count(), 1);
    await command('orderedList');
    await command('blockquote'); assert.equal(await field.locator('blockquote').count(), 1);
    await command('blockquote');
    // Autosave must preserve the actual mounted node, focus, and selected text.
    await field.focus(); await field.press('ControlOrMeta+a');
    const beforeSelection = await field.evaluate(el => { window.savedEditorNode = el; return getSelection().toString(); });
    await page.evaluate(() => window.editorSession.saveNow());
    assert.deepEqual(await field.evaluate(el => [el === window.savedEditorNode, el === document.activeElement, getSelection().toString()]), [true, true, beforeSelection]);
    // Ordinary paragraph and explicit line break, committed immediately before switching blocks.
    await field.press('ArrowRight'); await field.press('End'); await field.press('Enter');
    await page.keyboard.insertText('第二段'); await field.press('Shift+Enter'); await page.keyboard.insertText('同段換行');
    const firstSaved = await page.evaluate(() => structuredClone(window.editorSession.state.draft.blocks[0].content));
    assert.match(firstSaved.text, /第二段\n同段換行/);
    await page.evaluate(() => { window.editorSession.createBlock('question'); window.editorSession.notifyStateChange(); });
    await field.fill('解釋你的答案'); await field.press('ControlOrMeta+a'); await command('underline'); await command('redText');
    const qId = await page.evaluate(() => window.editorSession.state.selectedBlockId);
    // The old block's formatting and undo history survive changing selection.
    await page.evaluate(id => { window.editorSession.state.selectedBlockId = id; window.editorSession.notifyStateChange(); }, firstId);
    assert.equal(await field.locator('u').count() > 0, true);
    assert.equal(await page.locator('[data-command="undo"]').isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => window.editorSession.state.draft.blocks[0].content), firstSaved);
    await page.evaluate(id => { window.editorSession.state.selectedBlockId = id; window.editorSession.notifyStateChange(); }, qId);
    // Chinese composition via Chromium's input protocol; this is not a real mobile keyboard.
    await field.focus(); await field.press('ControlOrMeta+End');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await page.evaluate(() => window.editorSession.saveNow());
    assert.equal(await field.evaluate(el => document.activeElement === el), true);
    await cdp.send('Input.insertText', { text: '中文' });
    await cdp.detach();
    await page.waitForFunction(() => window.editorSession.state.draft.blocks.at(-1).prompt.text.includes('中文'));
    // Both question prompt and content survive a real reload and serialization.
    await page.evaluate(() => window.editorSession.saveNow());
    await page.reload(); await field.waitFor();
    assert.match(await field.innerText(), /中文/);
    assert.equal(await field.locator('u').count() > 0, true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    if (shots) await page.screenshot({ path: `${shots}/rich-editor-${locale}-${width}.png`, fullPage: true });
    const payload = await page.evaluate(async () => {
      const { createWorksheetPackageFromDraft, parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
      const pkg = createWorksheetPackageFromDraft(await window.editorSession.saveNow());
      if (pkg.manifest.packageVersion !== 7) throw new Error('Expected rich package v7');
      return { worksheetId: 'rich-w', snapshotId: 'rich-s', snapshotVersion: 1, title: 'Rich worksheet', blocks: parseWorksheetPackage(pkg.bytes).worksheet.blocks };
    });
    const viewerRequests = [];
    page.on('request', request => viewerRequests.push(request.url()));
    await page.goto(base + '/server/viewer/index.html');
    await page.evaluate(async payload => {
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      await viewerStorage.attempts.put({ localId: 'rich-attempt', localAttemptId: 'rich-attempt', status: 'in_progress', startedAt: new Date().toISOString(),
        lastActiveBlockId: payload.blocks[1].blockId, lastActiveIndex: 1, viewerPayload: payload, answers: {}, metadata: { localId: 'rich-attempt', origin: 'local_source', updatedAt: new Date().toISOString() } });
    }, payload);
    await page.goto(base + '/server/viewer/index.html?localAttemptId=rich-attempt');
    await page.locator('.question-card__prompt-label u .worksheet-text-red').waitFor();
    assert.equal(viewerRequests.some(url => url.includes('/vendor/rich-text-engine')), false);
    await page.locator('.viewer-answer-area > textarea').first().fill('A literal answer');
    await page.evaluate(() => window.viewerSession.completeLocalAttempt());
    await page.waitForFunction(() => window.viewerSession.state.status === 'completed');
    assert.equal(await page.locator('.question-card__prompt-label u').count() > 0, true);
    const html = await page.evaluate(async () => {
      const { buildWorksheetPrintReportModel, buildWorksheetPrintReportHtml } = await import('/server/viewer/main.js');
      const s = window.viewerSession;
      return buildWorksheetPrintReportHtml(await buildWorksheetPrintReportModel({ viewerPayload: s.state.viewerPayload, answers: s.state.answers }));
    });
    const print = await context.newPage();
    await print.evaluate(() => { window.print = () => {}; window.close = () => {}; });
    await print.setContent(html); await print.emulateMedia({ media: 'print' });
    assert.equal(await print.locator('.print-question-text u .worksheet-text-red').count() > 0, true);
    assert.equal(await print.locator('.print-question-text .worksheet-text-red').first().evaluate(el => getComputedStyle(el).color), 'rgb(180, 35, 24)');
    if (shots) await print.screenshot({ path: `${shots}/rich-print-${locale}-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS rich editor ${locale} ${width}: marks, blocks, history, composition, reload, package, review, print`);
  }
  // Failed lazy loading can be retried, and completion after a block switch stays scoped.
  const context = await browser.newContext();
  const page = await context.newPage();
  let requests = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  await context.route('**/vendor/rich-text-engine.js*', async route => {
    if (++requests === 1) return route.fulfill({ status: 503, body: 'fixture failure' });
    await ready; return route.continue();
  });
  await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { user: { sub: 'fixture' }, items: [] } } }));
  await page.goto(base + '/server/editor/index.html');
  const retry = page.locator('.editor-rich-text [role="status"] button');
  await retry.waitFor(); await retry.click();
  await page.evaluate(() => { window.editorSession.createBlock('question'); window.editorSession.notifyStateChange(); });
  release();
  await page.locator('#editor-block-editor').fill('Only the new question');
  assert.deepEqual(await page.evaluate(() => window.editorSession.state.draft.blocks.map(block => (block.prompt || block.content).text)), ['', 'Only the new question']);
  assert.equal(requests, 2);
  await context.close();
  console.log('PASS failed-load retry and delayed editor ownership');
} finally { await browser.close(); }
