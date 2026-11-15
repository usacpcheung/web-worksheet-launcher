import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
 const context = await browser.newContext();
 try {
  await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ status: 401, json: { ok: false, error: { code: 'AUTH_REQUIRED' } } }));
  const a = await context.newPage(); a.setDefaultTimeout(10000);
  await a.goto(`${base}/server/viewer/`);
  await a.evaluate(async () => {
    const { viewerStorage: s } = await import('/server/viewer/storage/index.js');
    const now = new Date().toISOString();
    const payload = { worksheetId:'a',snapshotId:'s',snapshotVersion:1,title:'A',blocks:[{blockId:'q',kind:'question',position:0,prompt:{text:'A'},responseConfig:{inputType:'text'}}]};
    await s.attempts.put({localId:'a',localAttemptId:'a',sourceType:'local_draft_preview',status:'in_progress',viewerPayload:payload,answers:{q:{value:'Keep A'}},metadata:{localId:'a',origin:'local_source',updatedAt:now}});
    s.resumeFlags.set('viewer:lastSession',{localId:'a',store:'localAttempts'});
    await s.drafts.put({localId:'b',title:'B',blocks:payload.blocks,metadata:{localId:'b',origin:'editor',updatedAt:now}});
  });
  // Pre-upgrade previews were normal attempts: do not hide the user's existing Resume.
  await a.goto(`${base}/server/viewer/`);
  await a.locator('.viewer-resume-card').waitFor();
  await a.goto(`${base}/server/viewer/?localAttemptId=a`);
  await a.waitForFunction(()=>window.viewerSession?.state.localAttemptId==='a');
  assert.equal(await a.evaluate(() => viewerSession.state.runtimeMode), 'normal');
  const b = await context.newPage(); b.setDefaultTimeout(10000);
  await b.goto(`${base}/server/viewer/?localDraftId=b`);
  await b.locator('.viewer-attempt-dialog button[type=submit]').click();
  await b.waitForFunction(()=>window.viewerSession?.state.localAttemptId);
  const bId = await b.evaluate(()=>viewerSession.state.localAttemptId);
  await a.evaluate(async()=>{viewerSession.setAnswer('q','A still being edited');await viewerSession.autosave();});
  assert.equal(await b.evaluate(()=>JSON.parse(localStorage.getItem('worksheetLauncher:resumeFlags'))['viewer:lastSession'].localId),bId);
  await b.evaluate(()=>viewerSession.lifecycle.cleanupRetired());
  assert.equal(await b.evaluate(async()=>!!await viewerSession.storage.attempts.get('a')),true,'active A survives cleanup');
  await a.close();
  // Exercise the post-navigation cleanup boundary without a one-minute test sleep.
  await b.evaluate(()=>{const key='worksheetLauncher:attemptNavigationHolds';const holds=JSON.parse(localStorage.getItem(key)||'{}');holds.a=Date.now()-1;localStorage.setItem(key,JSON.stringify(holds));});
  await b.evaluate(()=>viewerSession.lifecycle.cleanupRetired());
  assert.equal(await b.evaluate(async()=>!!await viewerSession.storage.attempts.get('a')),false);
  // A stale per-tab recovery journal cannot recreate an explicitly retired attempt.
  assert.equal(await b.evaluate(async()=>{
    const {writeRecovery}=await import('/server/app/storage/recovery-journal.js');
    writeRecovery('localAttempts',{localId:'a',metadata:{localId:'a',origin:'local_source',updatedAt:new Date().toISOString()},answers:{q:{value:'stale'}}});
    return !!await viewerSession.storage.attempts.get('a');
  }),false);
  // A failed incoming attempt save leaves B selected and usable.
  const c=await context.newPage(); c.setDefaultTimeout(10000);
  await c.goto(`${base}/server/viewer/?localDraftId=b`);
  await c.locator('.viewer-attempt-dialog').waitFor();
  await c.evaluate(async()=>{const {viewerStorage:s}=await import('/server/viewer/storage/index.js');s.attempts.put=async()=>{throw new Error('QA quota failure');};});
  await c.locator('.viewer-attempt-dialog button[type=submit]').click();
  await c.locator('.viewer-fatal-panel').waitFor();
  assert.equal(await b.evaluate(()=>JSON.parse(localStorage.getItem('worksheetLauncher:resumeFlags'))['viewer:lastSession'].localId),bId);
  assert.equal(await b.evaluate(async id=>!!await viewerSession.storage.attempts.get(id),bId),true);
  // A concurrent edit after B's replacement has been staged requires fresh consent.
  await c.goto(`${base}/server/viewer/?localDraftId=b`);
  await c.locator('.viewer-attempt-dialog').waitFor();
  await c.evaluate(async currentId => {
    const { viewerStorage: s } = await import('/server/viewer/storage/index.js');
    const put = s.attempts.put; let first = true;
    s.attempts.put = async record => {
      const result = await put(record);
      if (first && record.localId !== currentId) {
        first = false; window.stagedReplacement = record.localId;
        const current = await s.attempts.get(currentId);
        current.answers.q = { value: 'Changed during replacement persistence' }; await put(current);
      }
      return result;
    };
  }, bId);
  await c.locator('.viewer-attempt-dialog button[type=submit]').click();
  await c.waitForFunction(() => window.stagedReplacement);
  await c.locator('.viewer-attempt-dialog button[type=button]').click();
  await c.locator('.viewer-resume-card').waitFor();
  assert.equal(await c.evaluate(async () => !!await (await import('/server/viewer/storage/index.js')).viewerStorage.attempts.get(window.stagedReplacement)), false);
  assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem('worksheetLauncher:resumeFlags'))['viewer:lastSession'].localId), bId);
  console.log('PASS active-tab protection, background autosave ownership, recovery tombstone, failed save and cancelled staged replacement');
  await b.evaluate(async () => {
    const s = viewerSession.storage, original = await s.attempts.get(viewerSession.state.localAttemptId);
    for (const id of ['legacy-one', 'legacy-two']) await s.attempts.put({ ...original, localId: id, localAttemptId: id,
      metadata: { ...original.metadata, localId: id, updatedAt: '2026-01-01T00:00:00.000Z' } });
  });
  await b.goto(`${base}/server/viewer/`);
  await b.locator('.viewer-local-cleanup button').last().waitFor({ state: 'visible' });
  await b.getByRole('button', { name: 'Later', exact: true }).click();
  await b.reload();
  await b.locator('.viewer-local-cleanup').waitFor();
  assert.equal(await b.getByRole('button', { name: 'Later', exact: true }).isVisible(), false);
  await b.getByRole('button', { name: 'Review local cleanup', exact: true }).click();
  await b.locator('.viewer-attempt-dialog').waitFor();
  if (process.env.VIEWER_SMOKE_SCREENSHOTS) await b.screenshot({ path: `${process.env.VIEWER_SMOKE_SCREENSHOTS}/cleanup-review.png` });
  // The review authorizes only the inspected records. Concurrent edits survive.
  await b.evaluate(async () => {
    const { viewerStorage: s } = await import('/server/viewer/storage/index.js');
    const changed = await s.attempts.get('legacy-two');
    changed.answers.q = { value: 'Edited after review' }; await s.attempts.put(changed);
  });
  await b.locator('.viewer-attempt-dialog button[type=submit]').click();
  await b.waitForFunction(async () => !await (await import('/server/viewer/storage/index.js')).viewerStorage.attempts.get('legacy-one'));
  assert.equal(await b.evaluate(async () => (await (await import('/server/viewer/storage/index.js')).viewerStorage.attempts.get('legacy-two')).answers.q.value), 'Edited after review');
  assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem('worksheetLauncher:resumeFlags'))['viewer:lastSession'].localId), bId);
  console.log('PASS cleanup notice, Later persistence, review confirmation, and concurrent-edit preservation');

 } finally {await context.close();}
 // The original audit reproduction: editor cleanup must retain bytes used by a normal attempt.
 const context2=await browser.newContext();
 try {
  await context2.route(url=>url.pathname.startsWith('/api/'),r=>r.fulfill({status:401,json:{ok:false,error:{code:'AUTH_REQUIRED'}}}));
  const editor=await context2.newPage();await editor.goto(`${base}/server/editor/`);await editor.waitForFunction(()=>window.editorSession);
  const draftId=await editor.evaluate(async()=>{
    const s=editorSession,id='retained-image',now=new Date().toISOString();
    const binary=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vrcAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    await s.storage.localAssets.put({localId:id,binary,metadata:{localId:id,origin:'editor',updatedAt:now,mimeType:'image/png'}});
    s.state.draft.title='Media audit';s.state.draft.blocks=[{blockId:'q',kind:'question',position:0,prompt:{text:'Picture',mediaRefs:[{usage:'question_image',assetId:id}]},responseConfig:{inputType:'text'}}];
    s.state.draft.assets=[{assetId:id,kind:'image',mimeType:'image/png'}];s.touchDraft();await s.autosave();return s.state.draft.localId;
  });
  const viewer=await context2.newPage();await viewer.goto(`${base}/server/viewer/?localDraftId=${draftId}`);await viewer.waitForFunction(()=>window.viewerSession?.state.localAttemptId);
  await editor.evaluate(()=>editorSession.startNewWorksheet());
  assert.equal(await viewer.evaluate(async()=>!!(await viewerSession.storage.localAssets.get('retained-image'))?.binary),true);
  assert.ok(await viewer.evaluate(async()=>(await viewerSession.buildUploadedAttemptPackage()).bytes.length)>0);
  console.log('PASS editor New worksheet retains media used by a saved normal attempt; attempt ZIP still builds');
 } finally {await context2.close();}
} finally {await browser.close();}
