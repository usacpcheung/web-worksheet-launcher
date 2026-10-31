import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
try {
 for (const locale of ['en','zh-Hant']) for (const target of ['prompt','option']) for (const scenario of ['cancel-login','cancel-confirm','generate','change-target','provider-auth']) {
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route(url=>url.pathname.startsWith('/api/'),r=>r.fulfill({json:{ok:true,data:{items:[]}}}));
  await page.goto(base+'/server/editor/'); await page.waitForFunction(()=>window.editorSession);
  await page.evaluate(async ({locale,scenario})=>{
   const i18n=await import('/server/app/i18n/index.js');i18n.setLocale(locale);
   const s=window.editorSession;s.state.draft.blocks=[{blockId:'q',kind:'question',position:0,prompt:{text:'Read the question'},responseConfig:{inputType:'multiple_choice',options:[{id:'o',value:'Answer',label:'Answer'}]}}];
   s.state.selectedBlockId='q';s._readAuth=null;window.signIns=0;window.requests=0;window.signedIn=scenario==='provider-auth';
   s.probeServerSessionSilently=async()=>{
    if(!window.signedIn)return {ok:false,status:'not_ready',error:{code:'AUTH_REQUIRED',status:401,requiresSignIn:true}};
    s.state.serverSession={status:'ready',user:{sub:'fixture'}};
    return {ok:true,status:'ready',user:{sub:'fixture'}};
   };
   s.beginServerSignIn=async()=>{window.signIns++;window.signedIn=true;return {ok:true};};
   s.apiClient.generateAudioFromText=async()=>{window.requests++;return scenario==='provider-auth'?{ok:false,error:{code:'AUTH_REQUIRED',status:401}}:{ok:true,data:new Uint8Array([1,2,3])};};
   s.notifyStateChange();
  },{locale,scenario});
  if(target==='option')await page.locator('[data-option-audio-menu-trigger]').first().click();
  const button=target==='prompt'?page.locator('[data-prompt-audio-track-language="english"] [data-audio-track-action="generate"]'):page.locator('[data-option-audio-language="english"][data-option-audio-action="generate"]');
  await button.click();
  if(scenario!=='provider-auth') {
   const modal=page.locator('.read-auth-prompt'); await modal.waitFor();
   assert.deepEqual(await page.evaluate(()=>[window.signIns,window.requests]),[0,0]);
   if(scenario==='cancel-login')await modal.locator('button').first().click();
   else {
    await modal.locator('button').nth(1).click();
    await page.waitForFunction(()=>document.querySelector('.read-auth-prompt button:nth-child(2)')?.textContent?.match(/Generate audio|產生語音/));
    assert.deepEqual(await page.evaluate(()=>[window.signIns,window.requests]),[1,0]);
    if(scenario==='change-target')await page.evaluate(()=>{window.editorSession.findBlock('q').prompt.text='Changed';window.editorSession.findBlock('q').responseConfig.options[0].label='Changed';});
    else await modal.locator('button').nth(scenario==='cancel-confirm'?0:1).click();
   }
  }
  await page.waitForFunction(()=>window.editorSession._audioOperations.size===0);
  assert.equal(await page.evaluate(()=>window.requests),['generate','provider-auth'].includes(scenario)?1:0);
  assert.equal(await page.evaluate(()=>window.signIns),['cancel-login','provider-auth'].includes(scenario)?0:1);
  await page.locator('.read-auth-prompt').waitFor({state:'detached'});
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Editor prompt/option audio: login consent, post-login confirmation, cancellation, stale targets and no provider replay pass in both locales');
} finally {await browser.close();}
