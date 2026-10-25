import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
  for (const kind of ['editor-draft','editor-publication','viewer-attempt','scene-draft','scene-publication','editor-publish','scene-publish']) {
    for (const locale of ['en','zh-Hant']) for (const recovery of kind.endsWith('publish') ? ['popup','same-tab'] : ['popup']) {
      const context = await browser.newContext({ viewport: {width: locale === 'en' ? 1280 : 390, height: 900} });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        const errors = [], requests = []; page.on('pageerror', error => errors.push(error.message));
        const app = kind.startsWith('scene') ? 'roleplayscene' : kind.split('-')[0];
        const published = kind.endsWith('publication'), publishing = kind.endsWith('publish');
        let signedIn = true, listRevision = 0;
        const row = {uploaded_draft_id:'fixture', uploaded_attempt_id:'fixture', published_package_id:published?'fixture':null,
          roleplayscene_uploaded_draft_id:'fixture',roleplayscene_published_scene_id:'fixture',owner_sub:'fixture',title:'QA fixture',subject:'Subject',publish_state:'draft_only'};
        await page.addInitScript(({locale,recovery}) => {
          localStorage.setItem('worksheetLauncher.locale',locale);
          window.open = () => recovery === 'popup' ? {closed:false} : null;
        },{locale,recovery});
        await page.route(url => url.pathname.startsWith('/api/'), route => {
          const req = route.request(), url = new URL(req.url());
          if (url.pathname.endsWith('/session')) return route.fulfill({status:signedIn?200:401,json:signedIn
            ? {ok:true,data:{ready:true,user:{sub:'fixture',email:'qa@example.test'}}} : {ok:false,error:{code:'AUTH_REQUIRED'}}});
          if (['POST','DELETE'].includes(req.method())) {
            requests.push({method:req.method(), body:req.postDataJSON()});
            return route.fulfill({json:{ok:true,data:{deleted:true,published_package_id:'saved',roleplayscene_published_scene_id:'saved'}}});
          }
          return route.fulfill({json:{ok:true,data:{items:[{...row,title:`QA fixture ${++listRevision}`}]}}});
        });
        await page.goto(`${base}/server/${app}/`);
        const label = key => page.evaluate(async key => (await import('/server/app/i18n/index.js')).t(key), key);
        const open = async () => {
          if(app==='roleplayscene') {
            const button = page.locator(published?'#server-browse-published-btn':'#server-manage-btn');
            if(!await button.isVisible()) await page.locator('#toolbar-more-btn').click();
            await button.click();
          } else {
            if(app==='editor') await page.waitForFunction(() => Boolean(window.editorSession));
            if(app==='editor') await page.locator('details').evaluateAll(nodes=>nodes.forEach(node=>{node.open=true;}));
            await page.getByRole('button',{name:await label(app==='editor'?(published?'editor.published.browse':'editor.uploadedDraft.manage'):'viewer.start.manageServerAttempts'),exact:true}).click();
          }
        };
        const publishLabel = await label('common.actions.publish');
        const action = () => app==='roleplayscene' ? page.locator(publishing?'[data-draft-action="publish"]':published?'[data-published-delete]':'[data-draft-action="delete"]').first()
          : publishing ? page.locator('.browse-modal').getByRole('button',{name:publishLabel,exact:true}).first() : page.locator('.browse-modal .uploaded-draft-action--danger').first();
        const form = () => app==='roleplayscene'?page.locator('#server-modal-overlay'):page.getByRole('dialog').last();
        // Editor can render cached rows before its manager preflight/refresh.
        // Expire only after fresh rows render, not while that read is pending.
        if (app === 'editor') await page.waitForFunction(() => Boolean(window.editorSession));
        const refreshed = app === 'editor' ? page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname.startsWith('/api/') && !url.pathname.endsWith('/session')
            && response.request().method() === 'GET';
        }) : null;
        await open();
        if (refreshed) {
          const freshRows = await (await refreshed).json();
          await page.locator('.browse-modal').getByText(freshRows.data.items[0].title, {exact:true}).waitFor();
        }
        await action().waitFor(); signedIn=false;
        await action().click();
        if(publishing) {
          await form().locator('input').first().fill('Prepared publication');
          await form().locator(app==='roleplayscene'?'textarea':'input').last().fill('Preserved metadata');
        }
        const confirmSelector = app==='roleplayscene' ? (publishing?'.confirm-actions__primary':'.server-danger-action') : (publishing?'.confirm-modal__btn--primary':'.confirm-modal__btn--destructive');
        await form().locator(confirmSelector).click();
        const prompt=page.locator('.read-auth-prompt'); await prompt.waitFor(); assert.equal(requests.length,0);
        if(recovery==='popup') signedIn=true;
        await prompt.getByRole('button',{name:await label('common.actions.signIn'),exact:true}).click();
        if(recovery==='same-tab') {
          const sameTab=prompt.getByRole('button',{name:await label('readAuth.sameTab'),exact:true});
          await sameTab.waitFor();signedIn=true;
          await Promise.all([page.waitForNavigation(),sameTab.click()]);
          await action().waitFor(); assert.equal(requests.length,0,'return does not publish');
          await action().click();
          assert.equal(await form().locator('input').first().inputValue(),'Prepared publication');
          assert.equal(await form().locator(app==='roleplayscene'?'textarea':'input').last().inputValue(),'Preserved metadata');
          await form().locator(confirmSelector).click();
        } else {
          const confirm=prompt.getByRole('button',{name:await label(publishing?'mutationAuth.publish':'mutationAuth.delete'),exact:true});
          await confirm.waitFor(); assert.equal(requests.length,0,'login never mutates');
          await confirm.click();
        }
        for(let i=0;requests.length===0&&i<100;i++) await page.waitForTimeout(50);
        assert.equal(requests.length,1); assert.equal(requests[0].method,publishing?'POST':'DELETE');
        if(publishing) { assert.equal(requests[0].body.title,'Prepared publication'); assert.equal(requests[0].body[app==='editor'?'subject':'description'],'Preserved metadata'); }
        assert.deepEqual(errors,[]);
        console.log(`PASS ${kind}/${locale}/${recovery}: expired-session preparation, explicit confirmation, retained metadata`);
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }
