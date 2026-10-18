import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
 for (const app of ['editor', 'viewer']) for (const locale of ['en', 'zh-Hant']) for (const width of [1280,390]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
   const page = await context.newPage(), requests = [], errors = [];
   page.setDefaultTimeout(15000);
   page.on('pageerror', error => errors.push(error.message));
   let mode = 'slot', deletions = 0; const pendingDeletes = []; const pendingLists = [];
   const row = { uploaded_draft_id: 'old', uploaded_attempt_id: 'old', title: 'Old package', subject: 'Subject' };
   await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
   await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/session')) return route.fulfill({ json: { ok:true, data:{ ready:true,user:{sub:'fixture'} } } });
    if (mode === 'list-stall' && request.method() === 'GET' && url.pathname.endsWith('/attempts')) { pendingLists.push(route); return; }
    if (request.method() === 'DELETE') { deletions++; pendingDeletes.push(route); return; }
    if (request.method() === 'POST') {
     requests.push({ bytes:request.postDataBuffer(), title:url.searchParams.get('title'), subject:url.searchParams.get('subject'), action:url.searchParams.get('conflictAction'), id:request.headers()['idempotency-key'] });
     const prefix = app === 'editor' ? 'DRAFT' : 'ATTEMPT';
     if (mode !== 'success') return route.fulfill({status:409,json:{ok:false,error:{code:`${prefix}_SLOT_LIMIT_REACHED`,details:{slotLimit:3,uploadedDrafts:[row],uploadedAttempts:[row]}}}});
     return route.fulfill({json:{ok:true,data:{uploaded_draft_id:'saved',uploaded_attempt_id:'saved'}}});
    }
    return route.fulfill({json:{ok:true,data:{items:[row]}}});
   });
      await page.goto(`${base}/server/${app}/`);
      if (app === 'viewer') {
        await page.evaluate(async () => {
          const { viewerStorage } = await import('/server/viewer/storage/index.js');
          const now = new Date().toISOString();
          await viewerStorage.attempts.put({ localId: 'cancel-ui', localAttemptId: 'cancel-ui', status: 'in_progress', startedAt: now,
            viewerPayload: { worksheetId: 'fixture', snapshotId: 'fixture', title: 'Cancel fixture', blocks: [{ blockId: 'q1', kind: 'question', position: 0, prompt: { text: 'Question' }, responseConfig: { inputType: 'text' } }] },
            answers: { q1: { value: 'Keep this answer' } }, metadata: { localId: 'cancel-ui', origin: 'local_source', updatedAt: now } });
        });
        await page.goto(`${base}/server/viewer/?localAttemptId=cancel-ui`);
      }
      await page.waitForFunction(app => ['ready','logged_in'].includes(window[`${app}Session`]?.state.serverSession.status), app);
      if (app === 'editor') await page.locator('details').filter({ has: page.locator('[data-upload-cancel="editor"]') }).locator('summary').click();
   const labels = await page.evaluate(async app => {
    const { t } = await import('/server/app/i18n/index.js');
    const keys = { upload:app==='editor'?'editor.server.uploadDraft':'viewer.upload.saveAttemptAriaLabel', copy:app==='editor'?'editor.modal.uploadConflict.saveAsNewCopy':'common.actions.saveAsCopy', delete:'common.actions.delete', confirm:app==='editor'?'editor.uploadedDraft.deleteDialog.confirm':'common.actions.delete', cancel:'common.actions.cancel' };
    return Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,t(v)]));
   },app);
   const button = page.getByRole('button',{name:labels.upload,exact:true});
   const settled = () => page.waitForFunction(app => !window[`${app}Session`].state[app==='editor'?'isUploadDraftFlowActive':'isUploadAttemptFlowActive'],app);
   const edit = title => page.evaluate(({app,title}) => {
    const session=window[`${app}Session`];
    if(app==='editor') { session.updateTitle(title); session.updateSubject(title); }
    else { session.state.viewerPayload.title=title; session.state.viewerPayload.subject=title; session.state.sourceSubject=title; session.setAnswer('q1',title); }
   },{app,title});

   const waitUntil = async predicate => {
     for (let i=0;i<100&&!predicate();i++) await page.waitForTimeout(20);
     assert.ok(predicate());
   };
   const confirmDelete = async () => {
     await page.getByRole('dialog').getByRole('button',{name:labels.delete,exact:true}).click();
     await page.getByRole('dialog').last().getByRole('button',{name:labels.confirm,exact:true}).click();
   };
   await edit('Deletion guard fixture');
   if(app==='editor') {
     const warning = await page.evaluate(async()=>{
       const {t}=await import('/server/app/i18n/index.js');
       await editorSession.autosave();
       const count=editorSession.state.lastContractValidationIssueCount;
       const expected=t('editor.localSaveValidationWarning',{count});
       const saved=editorSession.state.lastValidationWarning;
       await editorSession.createOrOpenByLocalDraftId(editorSession.state.draft.localId);
       return {count,expected,saved,reopened:editorSession.state.lastValidationWarning};
     });
     assert.ok(warning.count>0);
     assert.equal(warning.saved,warning.expected);
     assert.equal(warning.reopened,warning.expected);
   }
   await button.click(); await confirmDelete(); await waitUntil(()=>deletions===1);
   const deleteButton=page.getByRole('dialog').getByRole('button',{name:labels.delete,exact:true});
   assert.equal(await deleteButton.isDisabled(),true);
   await deleteButton.evaluate(el=>el.click());
   assert.equal(await page.getByRole('dialog').count(),1);
   assert.equal(deletions,1);
   mode='success'; await pendingDeletes[0].fulfill({json:{ok:true,data:{deleted:true}}});
   await settled(); assert.equal(requests.length,2);

   mode='slot'; await button.click(); await confirmDelete(); await waitUntil(()=>deletions===2);
   await pendingDeletes[1].fulfill({status:503,json:{ok:false,error:{code:'NETWORK_ERROR'}}});
   await page.waitForFunction(()=>!document.querySelector('.browse-results button')?.disabled);
   assert.equal(await page.getByRole('dialog').getByRole('button',{name:labels.delete,exact:true}).isEnabled(),true);
   await page.getByRole('dialog').getByRole('button',{name:labels.cancel,exact:true}).click();
   await settled(); assert.equal(requests.length,3);

   mode='slot'; await button.click(); await confirmDelete(); await waitUntil(()=>deletions===3);
   await page.getByRole('dialog').getByRole('button',{name:labels.cancel,exact:true}).click();
   await settled(); mode='success'; await button.click(); await settled();
   const feedback=()=>page.evaluate(app=>JSON.stringify({message:window[`${app}Session`].state.serverActionMessage,notices:window[`${app}Session`].state.notifications.filter(n=>app!=='editor'||n.category==='server').map(n=>({kind:n.kind,text:n.text}))}),app);
   const before=await feedback();
   await pendingDeletes[2].fulfill({status:404,json:{ok:false,error:{code:'NOT_FOUND'}}});
   await page.waitForTimeout(100);
   assert.equal(await feedback(),before,'closed deletion must not replace new upload feedback');
   assert.equal(requests.length,5);

   if(app==='viewer') for(const stop of ['cancel','timeout']) {
     await page.evaluate(async stop=>{
       const {createServerApiClient}=await import('/server/app/api/server-api-client.js');
       viewerSession.apiClient=createServerApiClient({listTimeoutMs:stop==='timeout'?100:15000});
     },stop);
     mode='list-stall'; const beforePosts=requests.length; const beforeLists=pendingLists.length;
     await button.click(); await waitUntil(()=>pendingLists.length>beforeLists);
     if(stop==='cancel') {
       const cancel=page.locator('[data-upload-cancel="viewer"]');
       assert.equal(await cancel.isVisible(),true); await cancel.click();
     }
     await settled(); assert.equal(await button.isEnabled(),true);
     assert.equal(requests.length,beforePosts+1); assert.equal(await page.getByRole('dialog').count(),0);
     // An obsolete transport completion cannot open a recovery dialog.
     await pendingLists.at(-1).fulfill({json:{ok:true,data:{items:[row]}}}).catch(()=>{});
     await page.waitForTimeout(50); assert.equal(await page.getByRole('dialog').count(),0);
     mode='success';await button.click();await settled();assert.equal(requests.length,beforePosts+2);
   }
   if(app==='viewer') {
     mode='success'; await page.evaluate(async()=>{ const {createServerApiClient}=await import('/server/app/api/server-api-client.js'); viewerSession.apiClient=createServerApiClient(); await viewerSession.listUploadedAttempts(); });
     mode='list-stall'; const beforeLists=pendingLists.length, beforePosts=requests.length;
     await button.click(); await waitUntil(()=>pendingLists.length===beforeLists+1);
     await page.evaluate(()=>{void viewerSession.listUploadedAttempts();});
     await waitUntil(()=>pendingLists.length===beforeLists+2);
     await pendingLists[beforeLists].fulfill({json:{ok:true,data:{items:[{uploaded_attempt_id:'obsolete',title:'Obsolete'}]}}});
     await settled();
     assert.equal(await page.getByRole('dialog').count(),0,'superseded success cannot open a cached-row deletion dialog');
     assert.equal(requests.length,beforePosts+1);
     await pendingLists[beforeLists+1].fulfill({json:{ok:true,data:{items:[{uploaded_attempt_id:'current',title:'Current'}]}}});
     await page.waitForFunction(()=>!viewerSession.state.isLoadingUploadedAttempts);
     assert.equal(await page.evaluate(()=>viewerSession.state.uploadedAttempts[0].title),'Current');
   }
   assert.deepEqual(errors,[]);
   console.log(`PASS ${app}/${locale}/${width}: guarded deletion, failed deletion unlock, stale feedback and recovery-list cancellation/deadline`);
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
