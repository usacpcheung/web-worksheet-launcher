import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
 for (const locale of ['en','zh-Hant']) for (const width of [1280,390]) {
  const context=await browser.newContext({viewport:{width,height:900}});
  try {
   const page=await context.newPage(), requests=[],errors=[];
   let deletions=0,mode='recovery';
   page.setDefaultTimeout(15000);
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(locale=>localStorage.setItem('worksheetLauncher.locale',locale),locale);
   const row={roleplayscene_uploaded_draft_id:'fixture',title:'Fixture',publish_state:'draft_only'};
   await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname.endsWith('/session'))return route.fulfill({json:{ok:true,data:{ready:true,user:{sub:'fixture'}}}});
    if(req.method()==='DELETE'){deletions++;return route.fulfill({json:{ok:true,data:{deleted:true}}});}
    if(req.method()==='POST'){
     requests.push({bytes:req.postDataBuffer(),action:url.searchParams.get('conflictAction'),id:req.headers()['idempotency-key']});
     const count=requests.length;
     if(mode==='cancel'||[1,4].includes(count))return route.fulfill({status:409,json:{ok:false,error:{code:'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT',details:{existingDraft:row}}}});
     if([2,3].includes(count))return route.fulfill({status:409,json:{ok:false,error:{code:'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED',details:{slotLimit:3,uploadedDrafts:[row]}}}});
     return route.fulfill({json:{ok:true,data:{roleplayscene_uploaded_draft_id:'saved'}}});
    }
    return route.fulfill({json:{ok:true,data:{items:[row]}}});
   });
   await page.goto(`${base}/server/roleplayscene/`);
   const labels=await page.evaluate(async()=>{
    const {t}=await import('/server/app/i18n/index.js');
    return Object.fromEntries(['conflictCopy','conflictReplace','deleteDraft','deleteConfirm','cancel'].map(k=>[k,t(`roleplayscene.server.${k}`)]));
   });
   const save=page.locator('#server-save-btn');
   if(!await save.isVisible())await page.locator('#toolbar-more-btn').click();
   await save.click();
   const modal=page.locator('#server-modal-overlay');
   await modal.getByRole('button',{name:labels.conflictCopy,exact:true}).click();
   for(let i=0;i<2;i++){
    await modal.getByRole('button',{name:labels.deleteDraft,exact:true}).click();
    await modal.getByRole('button',{name:labels.deleteConfirm,exact:true}).click();
   }
   await modal.getByRole('button',{name:labels.conflictReplace,exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#server-save-btn').getAttribute('aria-busy')==='false');
   assert.equal(requests.length,5);assert.equal(deletions,2);
   assert.deepEqual(requests.map(r=>r.action),[null,'copy','copy','copy','replace']);
   assert.ok(requests.every(r=>r.bytes.equals(requests[0].bytes)&&r.id));
   assert.equal(new Set(requests.map(r=>r.id)).size,5);
   mode='cancel';
   if(!await save.isVisible())await page.locator('#toolbar-more-btn').click();
   await save.click();await modal.getByRole('button',{name:labels.cancel,exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#server-save-btn').getAttribute('aria-busy')==='false');
   assert.equal(requests.length,6);assert.deepEqual(errors,[]);
   console.log(`PASS RolePlayScene repeated recovery and cancellation ${locale}/${width}`);
  }finally{await context.close();}
 }
}finally{await browser.close();}
