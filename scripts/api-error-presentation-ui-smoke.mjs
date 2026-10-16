import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const base=process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser=await chromium.launch();
try {
 for(const app of ['editor','viewer','roleplayscene']) for(const locale of ['en','zh-Hant']) {
  const context=await browser.newContext({viewport:{width:locale==='en'?1280:390,height:900}});
  try {
   const page=await context.newPage(), errors=[];let posts=0;
   page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(locale=>localStorage.setItem('worksheetLauncher.locale',locale),locale);
   await page.route(url=>url.pathname.startsWith('/api/'),route=>{
    if(new URL(route.request().url()).pathname.endsWith('/session')) return route.fulfill({json:{ok:true,data:{ready:true,user:{sub:'fixture'}}}});
    if(route.request().method()==='POST'){posts++;return route.fulfill({status:422,json:{ok:false,error:{code:'UNKNOWN_SERVICE_FAILURE',message:'UNTRANSLATED_SECRET_<img src=x onerror=alert(1)>',details:{token:'do-not-display'}}}})}
    return route.fulfill({json:{ok:true,data:{items:[]}}});
   });
   await page.goto(`${base}/server/${app}/`);
   if(app==='viewer') {
    await page.evaluate(async()=>{
     const { viewerStorage }=await import('/server/viewer/storage/index.js');
     await viewerStorage.attempts.put({localId:'error-fixture',localAttemptId:'error-fixture',status:'in_progress',viewerPayload:{worksheetId:'w',snapshotId:'s',title:'Fixture',blocks:[{blockId:'q',kind:'question',position:0,prompt:{text:'Question'},responseConfig:{inputType:'text'}}]},answers:{},metadata:{localId:'error-fixture',origin:'local_source',updatedAt:new Date().toISOString()}});
    });
    await page.goto(`${base}/server/viewer/?localAttemptId=error-fixture`);
   }
   if(app==='roleplayscene'){
    const save=page.locator('#server-save-btn');
    if(!await save.isVisible())await page.locator('#toolbar-more-btn').click();
    await save.click();
    await page.waitForFunction(()=>document.querySelector('#server-save-btn').getAttribute('aria-busy')==='false');
   }else{
    await page.waitForFunction(app=>['ready','logged_in'].includes(window[`${app}Session`]?.state.serverSession.status),app);
    await page.evaluate(async app=>{
     const session=window[`${app}Session`];
     await (app==='editor'?session.uploadCurrentDraftToServer():session.uploadCurrentAttemptPackage());
    },app);
   }
   const expected=await page.evaluate(async()=> (await import('/server/app/api/error-presentation.js')).getApiErrorMessage({error:{code:'UNKNOWN_SERVICE_FAILURE',status:422}},'upload'));
   const visible=await page.locator('body').innerText();
   assert.ok(visible.includes(expected),`${app}/${locale}: localized upload failure`);
   assert.ok(!visible.includes('UNTRANSLATED_SECRET'));assert.ok(!visible.includes('do-not-display'));
   assert.equal(posts,1);assert.deepEqual(errors,[]);
   if(app==='viewer') {
    const details=page.locator('.notification-toast details').first();
    const summary = details.locator('summary');
    await summary.click();
    assert.equal(await details.evaluate(element => element.open), true);
    assert.match(await details.innerText(),/UNKNOWN_SERVICE_FAILURE/);
    assert.ok(!(await details.innerText()).includes('UNTRANSLATED_SECRET'));
    await summary.focus();
    await summary.press('Enter');
    assert.equal(await details.evaluate(element => element.open), false);
    await summary.press('Enter');
    assert.equal(await details.evaluate(element => element.open), true);
    assert.equal(await details.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'details wrap at narrow widths');
   }
   if (process.env.VIEWER_SMOKE_SCREENSHOTS) {
    await mkdir(process.env.VIEWER_SMOKE_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.VIEWER_SMOKE_SCREENSHOTS, `${app}-${locale}.png`) });
   }
  } finally {await context.close()}
 }
 console.log('PASS: localized unknown API errors in all apps, both languages and narrow layouts; safe details, one POST');
} finally {await browser.close()}
