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
   let mode = 'recovery', deletions = 0;
   const row = { uploaded_draft_id: 'old', uploaded_attempt_id: 'old', title: 'Old package', subject: 'Subject' };
   await page.addInitScript(locale => localStorage.setItem('worksheetLauncher.locale', locale), locale);
   await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/session')) return route.fulfill({ json: { ok:true, data:{ ready:true,user:{sub:'fixture'} } } });
    if (request.method() === 'DELETE') { deletions++; return route.fulfill({ json:{ok:true,data:{deleted:true}} }); }
    if (request.method() === 'POST') {
     requests.push({ bytes:request.postDataBuffer(), title:url.searchParams.get('title'), subject:url.searchParams.get('subject'), action:url.searchParams.get('conflictAction'), id:request.headers()['idempotency-key'] });
     const prefix = app === 'editor' ? 'DRAFT' : 'ATTEMPT';
     if (mode === 'cancel' || (mode === 'recovery' && requests.length === 1)) return route.fulfill({status:409,json:{ok:false,error:{code:`${prefix}_NAME_CONFLICT`,details:{existingDraft:row,existingAttempt:row}}}});
     if (mode === 'recovery' && requests.length === 2) return route.fulfill({status:409,json:{ok:false,error:{code:`${prefix}_SLOT_LIMIT_REACHED`,details:{slotLimit:3,uploadedDrafts:[row],uploadedAttempts:[row]}}}});
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
    if(app==='editor') { session.state.draft.title=title; session.state.draft.metadata.subject=title; }
    else { session.state.viewerPayload.title=title; session.state.viewerPayload.subject=title; session.state.sourceSubject=title; session.state.answers.q1={value:title}; }
   },{app,title});
   await edit('Original snapshot');
   await button.click();
   await page.getByRole('dialog').waitFor();
   await page.evaluate(app => { window.completedPackageFlow = window[`${app}Session`]._uploadPackageFlow; }, app);
   await edit('Edited during conflict');
   await page.getByRole('dialog').getByRole('button',{name:labels.copy,exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:labels.delete,exact:true}).click();
   await edit('Edited during deletion');
   await page.getByRole('dialog').last().getByRole('button',{name:labels.confirm,exact:true}).click();
   await settled();
   assert.equal(requests.length,3); assert.equal(deletions,1);
   assert.ok(requests.every(r=>r.title==='Original snapshot' && r.subject==='Original snapshot'));
   assert.deepEqual(requests[0].bytes,requests[1].bytes); assert.deepEqual(requests[1].bytes,requests[2].bytes);
   assert.deepEqual(requests.slice(1).map(r=>r.action),['copy','copy']);
   assert.ok(requests.every(r=>r.id)); assert.equal(new Set(requests.map(r=>r.id)).size,3,'new authorized requests use distinct operation IDs');
   assert.equal(await page.evaluate(app=>window[`${app}Session`]._uploadPackageFlow,app),null);
   assert.equal(await page.evaluate(() => window.completedPackageFlow.preparedPackage),null);
   mode='cancel'; await button.click();
   await page.getByRole('dialog').waitFor();
   await edit('After cancellation');
   await page.getByRole('dialog').getByRole('button',{name:labels.cancel,exact:true}).click();
   await settled();
   assert.equal(await page.evaluate(app=>window[`${app}Session`]._uploadPackageFlow,app),null);
   mode='success'; await button.click(); await settled();
   assert.equal(requests.length,5); assert.equal(requests[4].title,'After cancellation');
   assert.notDeepEqual(requests[4].bytes,requests[0].bytes);
   // Reopening the same ID in a new generation invalidates a retained snapshot.
   mode='cancel'; await button.click();
   await page.getByRole('dialog').waitFor();
   const beforeStaleChoice=requests.length;
   await page.evaluate(app => {
    const session=window[`${app}Session`];
    if(app==='editor') session._audioDraftGeneration++;
    else session._uploadContextGeneration++;
   },app);
   await page.getByRole('dialog').getByRole('button',{name:labels.copy,exact:true}).click();
   await settled();
   assert.equal(requests.length,beforeStaleChoice,'stale snapshot cannot be resubmitted');
   assert.equal(await page.evaluate(app=>window[`${app}Session`]._uploadPackageFlow,app),null);
   assert.deepEqual(errors,[]);
   console.log(`PASS ${app}/${locale}/${width}: stable ZIP/metadata, slot recovery, fresh operation IDs, cancellation and fresh next upload`);
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
