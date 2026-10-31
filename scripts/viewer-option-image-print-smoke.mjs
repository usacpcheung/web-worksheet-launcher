import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    await page.goto(base + '/server/viewer/');
    await page.evaluate(async locale => {
      localStorage.setItem('worksheetLauncher.locale', locale);
      const { viewerStorage } = await import('/server/viewer/storage/index.js');
      const now = new Date().toISOString();
      for (const [id, width, height, type] of [['landscape',400,240,'image/png'],['wide',520,250,'image/jpeg'],['portrait',240,400,'image/webp']]) {
        const c = document.createElement('canvas'); c.width = width; c.height = height;
        const g = c.getContext('2d'); g.strokeStyle = '#245c99'; g.lineWidth = 8; g.strokeRect(4,4,width-8,height-8);
        g.fillStyle = '#245c99'; g.font = '24px sans-serif'; g.fillText(id,20,50);
        const blob = await new Promise(resolve => c.toBlob(resolve,type));
        await viewerStorage.localAssets.put({ localId:id, binary:new Uint8Array(await blob.arrayBuffer()), metadata:{localId:id,origin:"local_source",mimeType:type,updatedAt:now} });
      }
      const imageOption = (id, asset, label) => ({id,value:id,label,mediaRefs:[{usage:'option_image',assetId:asset}],imageDescription:asset});
      const long = locale === 'en' ? 'A healthy routine includes enough sleep, balanced meals and regular exercise. '.repeat(4) : '健康的生活習慣包括充足睡眠、均衡飲食和適量運動。'.repeat(8);
      const blocks = [
        {blockId:'intro',kind:'content',content:{text:'Reading 閱讀資料 — choose carefully.'}},
        {blockId:'long',kind:'question',prompt:{text:'Choose a healthy routine. 選擇健康的生活習慣。'},responseConfig:{inputType:'multiple_choice',options:[imageOption('a','landscape',long),imageOption('b','portrait',''),{id:'c',value:'c',label:'Text-only option 純文字選項'}]}},
        {blockId:'normal',kind:'question',prompt:{text:'Select an image. 選擇圖片。'},responseConfig:{inputType:'multiple_choice',selectionMode:'multi',options:[imageOption('d','wide','Ordinary image caption 一般圖片說明'),imageOption('e','landscape','Another image 另一圖片'),imageOption('f','portrait','Portrait 直向圖片'),imageOption('g','missing','Missing image 圖片無法載入')]}}
      ].map((b,position)=>({...b,position}));
      await viewerStorage.attempts.put({localId:'image-print',localAttemptId:'image-print',status:'completed',startedAt:now,submittedAt:now,studentName:'QA',
        viewerPayload:{worksheetId:'image-print',snapshotId:'image-print',snapshotVersion:1,title:'Image print 圖片列印',blocks},
        answers:{long:{value:'a'},normal:{value:['d','f']}},metadata:{localId:"image-print",origin:"local_source",updatedAt:now}});
    }, locale);
    await page.goto(base + '/server/viewer/?localAttemptId=image-print');
    await page.locator('.viewer-option-image img').first().waitFor();
    await page.evaluate(() => {
      const open = window.open.bind(window);
      window.open = (...args) => { const popup = open(...args); popup.print = () => { popup.printed = true; }; popup.close = () => {}; return popup; };
    });
    const ready = page.waitForEvent('popup');
    await page.locator('.viewer-header-actions > button').last().click();
    const printed = await ready;
    await printed.waitForFunction(() => window.printed);
    await printed.emulateMedia({media:'print'});
    await printed.setViewportSize({width:688,height:1000});
    await printed.evaluate(() => document.fonts.ready);
    assert.equal(await printed.locator('.print-option-image').count(),5);
    assert.equal(await printed.locator('.print-choice.is-selected').count(),3);
    const measurements = await printed.locator('.print-choice:has(.print-option-image)').evaluateAll(nodes => nodes.map(n => {
      const label=n.querySelector('.print-choice-label').getBoundingClientRect(), image=n.querySelector('img').getBoundingClientRect();
      return {labelWidth:label.width,labelBottom:label.bottom,imageTop:image.top,imageHeight:image.height,imageWidth:image.width,rowWidth:n.clientWidth,overflow:n.scrollWidth>n.clientWidth};
    }));
    for (const m of measurements) {
      assert(m.labelWidth > 400, `Caption collapsed: ${JSON.stringify(m)}`);
      assert(m.imageTop >= m.labelBottom - 1, `Image must be below caption: ${JSON.stringify(m)}`);
      assert(m.imageHeight <= 133 && m.imageWidth <= m.rowWidth && !m.overflow);
    }
    assert.equal(await printed.locator('button,input,textarea').count(),0);
    assert.equal(await printed.evaluate(() => [...document.styleSheets[0].cssRules][0].type), 3, 'Font import must remain the first CSS rule');
    const pdf = await printed.pdf({format:'A4',preferCSSPageSize:true,printBackground:true,...(shots?{path:`${shots}/option-images-${locale}.pdf`}:{})});
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;
    assert(pages >= 1 && pages <= 2, `Unexpected page count: ${pages}`);
    if(shots) await printed.screenshot({path:`${shots}/option-images-${locale}.png`,fullPage:true});
    assert.deepEqual(errors,[]); console.log(`${locale}: readable image captions, intact markers/images, ${pages} PDF pages`);
    await context.close();
  }
} finally { await browser.close(); }
