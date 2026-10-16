import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
 for (const locale of ['en','zh-Hant']) {
  const context = await browser.newContext({viewport:{width:locale === 'en' ? 1280 : 390,height:900}});
  try {
   const page = await context.newPage(), errors = [];
   page.on('pageerror', error => errors.push(error.message));
   let posts = 0, lookups = 0, release, mode = 'cancel';
   await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale',locale),locale);
   await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/session')) return route.fulfill({json:{ok:true,data:{ready:true,user:{sub:'fixture'}}}});
    if (url.pathname.includes('/upload-operations/')) {
     lookups++;
     if (mode === 'cancel') await new Promise(resolve => {release=resolve});
     return route.fulfill({status:404,json:{ok:false,error:{code:'UNSUPPORTED'}}}).catch(()=>{});
    }
    if (route.request().method() === 'POST') {posts++;return route.abort('failed')}
    return route.fulfill({json:{ok:true,data:{items:[]}}});
   });
   await page.goto(`${base}/server/roleplayscene/`);
   const save = page.locator('#server-save-btn');
   if (!await save.isVisible()) await page.locator('#toolbar-more-btn').click();
   await save.click();
   for(let i=0;!release && i<100;i++) await page.waitForTimeout(20);
   assert.ok(release,'receipt lookup must be pending');
   if (!await save.isVisible()) await page.locator('#toolbar-more-btn').click();
   await save.click();
   await page.waitForFunction(()=>document.querySelector('#server-save-btn').getAttribute('aria-busy')==='false');
   const expected = await page.evaluate(async locale => (await import(`/server/app/i18n/locales/${locale}.js`)).default.apiErrors,locale);
   assert.equal(await page.locator('.app-messages__text').textContent(),expected.uploadCanceled);
   assert.match(expected.uploadCanceled,locale==='en'?/server may already have saved/:/伺服器可能已儲存/);
   const count=lookups;release();await page.waitForTimeout(350);
   assert.equal(lookups,count);assert.equal(posts,1);
   mode='uncertain';
   if (!await save.isVisible()) await page.locator('#toolbar-more-btn').click();
   await save.click();
   await page.waitForFunction(()=>document.querySelector('#server-save-btn').getAttribute('aria-busy')==='false');
   assert.equal(await page.locator('.app-messages__text').textContent(),expected.uploadUncertain);
   assert.equal(posts,2);assert.deepEqual(errors,[]);
  } finally {await context.close()}
 }
 console.log('PASS: RolePlayScene cancellation and uncertain upload feedback localized; no automatic POST retry');
} finally {await browser.close()}
