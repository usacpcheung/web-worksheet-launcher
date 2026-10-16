import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
let browser;
try {
 browser=await chromium.launch();
 for(const app of ['editor','viewer'])for(const locale of ['en','zh-Hant'])for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900}});
  const page=await context.newPage();
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
  const result=await page.evaluate(async({app,locale})=>{
   const {setLocale,t}=await import('/server/app/i18n/index.js');
   setLocale(locale,{persist:false});
   const session=window[`${app}Session`];
   session.state.serverActionMessage=null;
   session.state.notifications=[];
   window.open=()=>({closed:false,close(){this.closed=true;}});
   session.beginServerSignIn();
   const expected=t(app==='editor' ? 'editor.notifications.auth.completeSignInPopup' : 'apiErrors.popupPending');
   const observed=app==='editor'?session.state.notifications.map(n=>n.text):[session.state.serverActionMessage];
   session._authPopupFlow?.cancel();
   if(app==='viewer') {
    let forwarded;
    session.beginServerSignIn({onStatusMessage: event => {forwarded=event;}});
    if(forwarded?.status!=='pending' || forwarded.message!==expected) throw Error('viewer override lost status or localized text');
    session._authPopupFlow?.cancel();
   }
   return {app,locale,expected,observed,delivered:observed.includes(expected)};
  },{app,locale});
  console.log(JSON.stringify(result));
  assert.equal(result.delivered,true, `${app}/${locale}/${width}: pending guidance must be delivered`);
  await context.close();
 }
 console.log('PASS: real editor/viewer popup guidance and viewer override metadata in both languages and viewport widths');
}finally{await browser?.close();}
