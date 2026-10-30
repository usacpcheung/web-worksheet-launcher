import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [locale, width] of [['en', 1280], ['zh-Hant', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    context.on('page', popup => popup.on('pageerror', error => errors.push(error.message)));
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { items: [] } } }));
    await page.goto(base + '/server/viewer/');
    await page.evaluate(async locale => {
      localStorage.setItem('worksheetLauncher.locale', locale);
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      const now = new Date().toISOString();
      const blocks = [
        { blockId: 'intro', kind: 'content', content: { text: '## Read first 閱讀資料\n**Important** instructions.', format: 'limited-markdown-v1' } },
        { blockId: 'text', kind: 'question', prompt: { text: 'Where do you enjoy reading? 你喜歡在哪裏閱讀？', mediaRefs: [{ usage: 'question_image', assetId: 'print-image' }] }, responseConfig: { inputType: 'text', displayMode: 'single_line' } },
        { blockId: 'between', kind: 'content', content: { text: 'Keep this content between questions.\n<script>not executable</script>' } },
        { blockId: 'choices', kind: 'question', prompt: { text: 'Choose activities 選擇活動' }, responseConfig: { inputType: 'multiple_choice', selectionMode: 'multi', shuffleOptions: true,
          options: ['Reading 閱讀', 'Walking 散步', 'Drawing 繪畫', 'Singing 唱歌'].map((label, i) => ({ id: 'o' + i, value: 'v' + i, label })) } },
        { blockId: 'bool', kind: 'question', prompt: { text: 'True or false 是非題' }, responseConfig: { inputType: 'boolean' } },
        { blockId: 'number', kind: 'question', prompt: { text: 'A number 數字' }, responseConfig: { inputType: 'number' } },
        { blockId: 'blank', kind: 'question', prompt: { text: 'Unanswered question 未作答' }, responseConfig: { inputType: 'text' } },
        { blockId: 'long-reading', kind: 'content', content: { text: '## Extended reading\n' + Array.from({length:80}, (_,i) => `Paragraph ${i+1}: Read and reflect. 閱讀並思考。`).join('\n\n') + '\n\nREADING-END', format: 'limited-markdown-v1' } },
        { blockId: 'long-answer', kind: 'question', prompt: { text: 'Explain your thoughts. 解釋你的想法。' }, responseConfig: { inputType: 'text', maxLength: 10000 } },
        { blockId: 'end', kind: 'content', content: { text: 'WORKSHEET-END 最後閱讀內容' } },
      ].map((block, position) => ({ ...block, position }));
      const canvas = document.createElement('canvas');
      canvas.width = 240; canvas.height = 80;
      const drawing = canvas.getContext('2d');
      drawing.fillStyle = '#e7f1ff'; drawing.fillRect(0, 0, 240, 80);
      drawing.fillStyle = '#20344d'; drawing.font = '18px sans-serif'; drawing.fillText('Worksheet image', 20, 45);
      const imageBlob = await new Promise(resolve => canvas.toBlob(resolve));
      await viewerStorage.localAssets.put({ localId: 'print-image', binary: new Uint8Array(await imageBlob.arrayBuffer()),
        metadata: { localId: 'print-image', origin: 'local_source', updatedAt: now, mimeType: 'image/png' } });
      await viewerStorage.attempts.put({ localId: 'print-fixture', localAttemptId: 'print-fixture', status: 'completed', startedAt: now, submittedAt: now,
        studentName: 'Test learner', lastActiveBlockId: 'intro', lastActiveIndex: 0,
        viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', snapshotVersion: 1, title: 'Worksheet print 工作紙列印', blocks },
        answers: { text: { value: 'In the library. 在圖書館。 **Literal answer**' }, choices: { value: ['v1', 'v3'] }, bool: { value: false }, number: { value: 0 },
          'long-answer': { value: Array.from({length:65}, (_,i) => `Answer line ${i+1}: My explanation. 我的解釋。`).join('\n') + '\nANSWER-END' } },
        metadata: { localId: 'print-fixture', origin: 'local_source', updatedAt: now } });
    }, locale);
    await page.goto(base + '/server/viewer/?localAttemptId=print-fixture');
    const printButton = page.locator('.viewer-header-actions > button').last();
    await printButton.waitFor();
    await page.evaluate(() => document.fonts.ready);
    const before = await page.evaluate(() => JSON.stringify({ answers: window.viewerSession.state.answers, blocks: window.viewerSession.state.viewerPayload.blocks }));
    const displayed = await page.locator('[data-block-id="choices"] .choice-button-group__item').evaluateAll(nodes => nodes.map(node => ({
      label: node.querySelector('.choice-button-group__label').textContent,
      selected: node.getAttribute('aria-pressed') === 'true',
    })));
    // Exercise the real popup/model/HTML flow while suppressing the native dialog.
    await page.evaluate(() => {
      const open = window.open.bind(window);
      window.open = (...args) => {
        const popup = open(...args);
        popup.print = () => { popup.printRequests = (popup.printRequests || 0) + 1; };
        popup.close = () => {};
        return popup;
      };
    });
    // Chromium can stall document.write CSS imports while opener interception is active.
    // API fixtures are only needed during viewer loading; let the real popup load fonts.
    await page.unrouteAll({ behavior: 'wait' });
    const popupReady = page.waitForEvent('popup');
    await printButton.click();
    const printed = await popupReady;
    printed.on('pageerror', error => errors.push(error.message));
    await printed.waitForFunction(() => window.printRequests === 1);
    await printed.setViewportSize({ width: 794, height: 1123 });
    await printed.emulateMedia({ media: 'print' });
    assert.deepEqual(await printed.locator('.print-report > article').evaluateAll(nodes => nodes.map(node => node.dataset.blockId)),
      ['intro','text','between','choices','bool','number','blank','long-reading','long-answer','end']);
    assert.deepEqual(await printed.locator('.print-question-ordinal').allTextContents(), ['01','02','03','04','05','06']);
    assert.match(await printed.locator('[data-block-id="intro"] h2').innerText(), /Read first/);
    assert.equal(await printed.locator('[data-block-id="between"] script').count(), 0);
    assert.match(await printed.locator('[data-block-id="between"]').innerText(), /<script>not executable<\/script>/);
    assert.deepEqual(await printed.locator('[data-block-id="choices"] .print-choice').evaluateAll(nodes => nodes.map(node => ({
      label: node.querySelector('.print-choice-label').textContent,
      selected: node.classList.contains('is-selected'),
    }))), displayed);
    assert.equal(await printed.locator('[data-block-id="bool"] .print-choice.is-selected .print-choice-label').innerText(), 'False');
    assert.match(await printed.locator('[data-block-id="number"] .print-answer-text').innerText(), /[:：] 0$/);
    assert.match(await printed.locator('[data-block-id="text"] .print-answer-text').innerText(), /\*\*Literal answer\*\*/);
    assert.match(await printed.locator('[data-block-id="blank"] .print-answer-text').innerText(), locale === 'en' ? /Not answered/ : /未作答/);
    assert.match(await printed.locator('[data-block-id="long-answer"] .print-answer-text').innerText(), /ANSWER-END$/);
    assert.match(await printed.locator('[data-block-id="long-reading"]').innerText(), /READING-END$/);
    assert(await printed.locator('.print-question-image').evaluate(image => image.complete && image.naturalWidth === 240));
    assert.equal(await printed.locator('button, input, textarea, .viewer-navigation, .viewer-operation-panel').count(), 0);
    assert(await printed.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.evaluate(() => JSON.stringify({ answers: window.viewerSession.state.answers, blocks: window.viewerSession.state.viewerPayload.blocks })), before);
    if (shots) {
      await page.screenshot({ path: `${shots}/utilities-${locale}.png` });
      await printed.screenshot({ path: `${shots}/print-${locale}.png` });
      await printed.pdf({ path: `${shots}/worksheet-${locale}.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Worksheet print order, formatting, answers, shuffle identity, real popup and bilingual layout passed');
} finally {
  await browser.close();
}
