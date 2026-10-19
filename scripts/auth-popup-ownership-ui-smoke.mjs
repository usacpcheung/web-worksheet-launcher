import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
let browser;
try {
 browser=await chromium.launch();
 for(const app of ['editor','viewer']) for(const phase of ['probe','list']) for(const ok of [true,false]) {
  const context=await browser.newContext(); const page=await context.newPage();
  await page.route(url=>url.pathname.startsWith('/api/'),route=>route.fulfill({json:{ok:true,data:{ready:true,user:{sub:'fixture'}}}}));
  await page.goto(`${base}/server/${app}/`);
  if(app==='viewer') {
   await page.evaluate(async()=>{
    const {viewerStorage}=await import('/server/viewer/storage/index.js');
    await viewerStorage.attempts.put({localId:'popup-review',localAttemptId:'popup-review',status:'in_progress',viewerPayload:{worksheetId:'w',snapshotId:'s',title:'Fixture',blocks:[{blockId:'q',kind:'question',position:0,prompt:{text:'Q'},responseConfig:{inputType:'text'}}]},answers:{},metadata:{localId:'popup-review',origin:'local_source',updatedAt:new Date().toISOString()}});
   });
   await page.goto(`${base}/server/viewer/?localAttemptId=popup-review`);
  }
  await page.waitForFunction(app=>Boolean(window[`${app}Session`]),app,{timeout:10000});
  const result=await page.evaluate(async ({app,phase,ok})=>{
   const session=window[`${app}Session`];
   window.open=()=>({closed:false,close(){this.closed=true;}});
   let enter, release;
   const entered=new Promise(resolve=>{enter=resolve;});
   const method=app==='editor'?'probeServerSessionSilently':'ensureServerSessionReady';
   if(phase==='probe') session[method]=()=>{enter();return new Promise(resolve=>{release=resolve;});};
   else session.apiClient[app==='editor'?'listUploadedDrafts':'listPublishedPackages']=()=>{enter();return new Promise(resolve=>{release=resolve;});};
   session.apiClient.getSession=async()=>({ok:true,data:{ready:true,user:{sub:'fixture'}}});
   session.beginServerSignIn();
   const old=session._authPopupFlow;
   await entered;
   session.apiClient.getSession=()=>new Promise(()=>{});
   // A second subscriber shares the running login. Explicit cancellation starts
   // a new lifecycle; late callbacks from the canceled lifecycle stay obsolete.
   const joined = session.beginServerSignIn();
   if (joined !== old.promise) throw new Error('Expected one login flow per app');
   session._activeAuthFlowId = null;
   old.cancel();
   session._authPopupFlow = null;
   session.beginServerSignIn();
   const newer=session._authPopupFlow, newerId=session._activeAuthFlowId;
   const before=app==='editor'?session.state.notifications.filter(n=>n.source?.startsWith('auth.')).map(n=>n.text):session.state.serverActionMessage;
   const authFeedbackBefore=JSON.stringify(session.state.authFeedback);
   const rows=app==='editor'?session.state.uploadedDrafts:session.state.publishedPackages;
   release(ok ? {ok:true,status:'ready',data:{items:[{title:'STALE_ROW'}]}} : {ok:false,error:{code:'NETWORK_ERROR'}});
   await old.promise;
   const after=app==='editor'?session.state.notifications.filter(n=>n.source?.startsWith('auth.')).map(n=>n.text):session.state.serverActionMessage;
   const result={app,phase,ok,feedbackPreserved:JSON.stringify(before)===JSON.stringify(after) && authFeedbackBefore===JSON.stringify(session.state.authFeedback),rowsPreserved:JSON.stringify(rows)===JSON.stringify(app==='editor'?session.state.uploadedDrafts:session.state.publishedPackages),newFlowHandleRetained:session._authPopupFlow===newer,newFlowIdRetained:session._activeAuthFlowId===newerId,flowHandleIsNull:session._authPopupFlow===null};
   newer.cancel();
   return result;
  },{app,phase,ok});
  console.log(JSON.stringify(result));
  assert.equal(result.newFlowHandleRetained,true);
  assert.equal(result.newFlowIdRetained,true);
  assert.equal(result.feedbackPreserved,true);
  assert.equal(result.rowsPreserved,true);
  await context.close();
 }
 console.log('PASS: old sign-in success/failure cannot replace new popup handles, feedback or lists after delayed probes/list responses');
}finally{await browser?.close();}
