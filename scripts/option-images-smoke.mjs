import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch();
try {
 for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: { ok: true, data: { items: [] } } }));
  await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
  await page.goto(base + '/server/editor/');
  await page.waitForFunction(() => window.editorSession);
  await page.evaluate(() => {
   const s = window.editorSession; s.state.draft.title = 'Option image fixture';
   s.state.draft.blocks = []; 
   const block = s.createBlock('question'); const id = s.state.selectedBlockId;
   s.updateQuestionInputType(id, 'multiple_choice');
   s.findBlock(id).prompt.text = 'Choose 圖片';
   s.notifyStateChange();
  });
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.editor-option-image-button').first().click();
  await (await chooser).setFiles({ name: 'square.png', mimeType: 'image/png', buffer: png });
  await page.locator('.editor-option-image-description textarea').waitFor({ timeout: 5000 });
  await page.evaluate(() => { const s = window.editorSession; s.updateQuestionOptionAtIndex(s.state.selectedBlockId, 1, 'Text'); });
  await page.locator('.editor-option-image-description textarea').fill('圖片描述');
  await page.locator('.option-correct-toggle').first().click();
  const data = await page.evaluate(async () => {
   const s = window.editorSession; await s.saveNow();
   const { parseWorksheetPackage } = await import('/server/editor/worksheet-package.js');
   const parsed = parseWorksheetPackage(await s.buildCurrentDraftPackageZipBytes());
   return { id: s.state.draft.localId, blockId: s.state.selectedBlockId, version: parsed.manifest.packageVersion, options: parsed.worksheet.blocks.find(b=>b.blockId===s.state.selectedBlockId).responseConfig.options };
  });
  assert.equal(data.version,4); assert.equal(data.options[0].label,''); assert.ok(data.options[0].value); assert.equal(data.options[0].imageDescription,'圖片描述');
  await page.locator('.editor-option-footer button').last().click();
  await page.locator('.editor-option-preview-dialog .viewer-option-image img').waitFor();
  const previewChoices = page.locator('.editor-option-preview-dialog [data-choice-value]');
  await previewChoices.first().focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await previewChoices.nth(1).evaluate(n => n.getRootNode().activeElement === n), true);
  if (shots) await page.screenshot({path: `${shots}/preview-${locale}-${width}.png`});
  await page.locator('.editor-option-preview-dialog > button').click();
  if (shots) await page.screenshot({path: `${shots}/editor-${locale}-${width}.png`});
  await page.goto(base + '/server/viewer/?preview=1&localDraftId=' + encodeURIComponent(data.id));
  const card = page.locator('[data-block-id="'+data.blockId+'"]');
  await card.locator('.viewer-option-image img').waitFor({timeout:10000}).catch(async e=>{await page.locator('details').first().evaluate(n=>n.open=true).catch(()=>{});console.log('UI errors',errors,'body',(await page.locator('body').innerText()).slice(0,2500));throw e;});
  await card.locator('.viewer-option-enlarge').first().waitFor({state:'visible'});
  await page.waitForFunction(()=>!!document.querySelector('.viewer-option-enlarge:not(:disabled)'));
  assert.equal(await card.locator('.viewer-option-image img').getAttribute('alt'),'圖片描述');
  await card.locator('[data-choice-value]').first().focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await card.locator('[data-choice-value]').nth(1).evaluate(n => document.activeElement === n), true);
  await card.locator('[data-choice-value]').first().click();
  if (shots) await page.screenshot({path: `${shots}/viewer-${locale}-${width}.png`});
  const before = await page.evaluate(()=>JSON.stringify(window.viewerSession.state.answers));
  await card.locator('.viewer-option-enlarge').first().click();
  assert.equal(await page.locator('.worksheet-image-dialog').evaluate(n=>n.open),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>JSON.stringify(window.viewerSession.state.answers)),before);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const attempt = await page.evaluate(async()=>{
   const s=window.viewerSession;const result=await s.buildUploadedAttemptPackage();
   const {buildWorksheetPrintReportModel,buildWorksheetPrintReportHtml} = await import('/server/viewer/main.js');
   const model=await buildWorksheetPrintReportModel({viewerPayload:s.state.viewerPayload,answers:s.state.answers,storage:s.storage});
   const html=buildWorksheetPrintReportHtml(model);
   const parsed=new DOMParser().parseFromString(html,'text/html');
   const printed=parsed.querySelector('.print-option-image');
   const prior=JSON.stringify(s.state.answers);
   await s.importAttemptPackageFromFile(result.bytes);
   return {version:result.manifest.packageVersion,assets:result.manifest.assets.length,option:s.state.viewerPayload.blocks.find(b=>b.kind==='question').responseConfig.options[0],printAlt:printed?.alt,printSource:printed?.src,restored:JSON.stringify(s.state.answers)===prior};
  });
  assert.equal(attempt.printAlt,'圖片描述');assert.match(attempt.printSource,/^data:image\/png/);assert.equal(attempt.restored,true);
  assert.equal(attempt.version,3);assert.equal(attempt.assets,1);assert.equal(attempt.option.imageDescription,'圖片描述');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Option images: editor, preview, package roundtrip, viewer selection/enlargement and attempt assets passed in both locales and sizes');
} finally { await browser.close(); }
