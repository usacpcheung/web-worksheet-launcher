import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const kind of ['editor-draft','editor-publication','viewer-attempt','scene-draft','scene-publication']) {
    for (const locale of ['en','zh-Hant']) for (const width of [1280,390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        const errors=[]; page.on('pageerror',e=>errors.push(e.message));
        const app=kind.startsWith('scene')?'roleplayscene':kind.split('-')[0];
        const published=kind.endsWith('publication');
        const row={uploaded_draft_id:'fixture',uploaded_attempt_id:'fixture',published_package_id:published?'fixture':null,
          roleplayscene_uploaded_draft_id:'fixture',roleplayscene_published_scene_id:'fixture',owner_sub:'fixture',title:'QA deletion fixture',subject:'Subject',publish_state:'draft_only'};
        let mode='uncertain', deletes=0, afterDelete=false;
        await page.addInitScript(locale=>localStorage.setItem('worksheetLauncher.locale',locale),locale);
        await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
          const req=route.request(),url=new URL(req.url());
          if(url.pathname.endsWith('/session'))return route.fulfill({json:{ok:true,data:{ready:true,user:{sub:'fixture',email:'qa@example.test'}}}});
          if(req.method()==='DELETE') {
            deletes++; afterDelete=true;
            if(mode==='uncertain')return route.abort('failed');
            return route.fulfill({json:{ok:true,data:{deleted:true}}});
          }
          if(afterDelete && mode==='refresh-failure')return route.fulfill({status:503,json:{ok:false,error:{code:'SERVICE_BUSY'}}});
          return route.fulfill({json:{ok:true,data:{items:[row]}}});
        });
        for(const scenario of ['uncertain','refresh-failure']) {
          mode=scenario;afterDelete=false;deletes=0;
          await page.goto(`${base}/server/${app}/`);
          const labels=await page.evaluate(async({app,published})=>{
            const {t}=await import('/server/app/i18n/index.js');
            return {open:t(app==='editor'?(published?'editor.published.browse':'editor.uploadedDraft.manage'):'viewer.start.manageServerAttempts'),
              cancel:t('common.actions.cancel'),uncertain:t('apiErrors.deleteUncertain'),refresh:t('apiErrors.deleteRefreshFailed')};
          },{app,published});
          if(app==='roleplayscene') {
            const opener=page.locator(published?'#server-browse-published-btn':'#server-manage-btn');
            if(!await opener.isVisible())await page.locator('#toolbar-more-btn').click();
            await opener.click();
          } else {
            if(app==='editor') await page.waitForFunction(()=>window.editorSession?.state.serverSession.status==='ready');
            if(app==='editor')await page.locator('details').filter({has:page.locator('[data-upload-cancel="editor"]')}).locator('summary').click();
            await page.getByRole('button',{name:labels.open,exact:true}).click();
          }
          const deleteButton = app==='roleplayscene'
            ? page.locator(published?'[data-published-delete]':'[data-draft-action="delete"]')
            : page.locator('.browse-modal .uploaded-draft-action--danger').first();
          await deleteButton.waitFor({state:'visible'});
          // Cancel once, then reuse the same UI after the reservation is released.
          await deleteButton.click();
          const confirmDialog=()=>app==='roleplayscene'?page.locator('#server-modal-overlay'):page.getByRole('dialog').last();
          await confirmDialog().getByRole('button',{name:labels.cancel,exact:true}).click();
          assert.equal(deletes,0);
          if(app==='roleplayscene') {
            const opener=page.locator(published?'#server-browse-published-btn':'#server-manage-btn');
            if(!await opener.isVisible())await page.locator('#toolbar-more-btn').click();
            await opener.click();
          }
          // Programmatically repeat the actual row event while confirmation is open.
          const handle=await deleteButton.elementHandle();
          await deleteButton.click();
          const confirmSelector=app==='roleplayscene'?'.server-danger-action':'.confirm-modal__btn--destructive';
          await confirmDialog().locator(confirmSelector).waitFor({state:'visible'});
          await handle.evaluate(button=>button.click());
          assert.equal(await confirmDialog().locator(confirmSelector).count(),1,'one confirmation per resource');
          await confirmDialog().locator(confirmSelector).click();
          const expected=scenario==='uncertain'?labels.uncertain:labels.refresh;
          await page.waitForFunction(text=>document.body.innerText.includes(text),expected);
          assert.equal(deletes,1,'no automatic DELETE replay');
          assert.deepEqual(errors,[]);
        }
        console.log(`PASS ${kind}/${locale}/${width}: cancellation, duplicate confirmation, uncertain response and confirmed deletion with failed refresh`);
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }
