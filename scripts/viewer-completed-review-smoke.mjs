// Isolated browser context; all API responses and microphone capture are synthetic.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const screenshots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
(async()=>{
const browser=await chromium.launch({headless:true});
try {
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const shot = async name => { if (screenshots) { await page.screenshot({path: screenshots + '/' + name, fullPage: false, animations: 'disabled'}); } };
let failRewrite=false; let transcriptions=0; let sessionReady=true; let rewrittenSource;
let finishTranscription;let hold=true;let finishRewrite;
await page.route(url => url.pathname.startsWith('/api/'),async route=>{
 const url=route.request().url();
 if(url.endsWith('/session')) return route.fulfill({json:sessionReady ? {ok:true,data:{user:{sub:'fixture',name:'Test learner'}}} : {ok:false,error:{code:'AUTH_REQUIRED'}}});
 if(url.endsWith('/transcriptions')) {transcriptions++;if(hold)await new Promise(r=>{finishTranscription=r});return route.fulfill({json:{ok:true,result:'synthetic segment'}});}
 if(url.endsWith('/rewrite')) { await new Promise(resolve=>{finishRewrite=resolve;}); rewrittenSource=route.request().postDataJSON().text; return route.fulfill({json:failRewrite ? {ok:false,error:{code:'UPSTREAM_FAILED'}} : {ok:true,result:'New segment'}}); }
 return route.fulfill({json:{ok:true,data:{items:[]}}});
});
await page.addInitScript(()=>{
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})},configurable:true});
 window.MediaRecorder=class {static isTypeSupported(){return true;} constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['synthetic audio'],{type:'audio/webm'})});this.onstop?.();});}};
});
await page.goto(base + '/server/viewer/index.html');
await page.evaluate(async()=>{
 const {viewerStorage}=await import('/server/viewer/storage/index.js');
 const now=new Date().toISOString();
 await viewerStorage.attempts.put({localId:'voice-smoke',localAttemptId:'voice-smoke',status:'in_progress',startedAt:now,lastActiveBlockId:'q1',lastActiveIndex:0,
 viewerPayload:{worksheetId:'worksheet-fixture',snapshotId:'snapshot-fixture',snapshotVersion:1,title:'Voice answer practice',blocks:[1,2].map(i=>({blockId:'q'+i,kind:'question',position:i-1,prompt:{text:'Describe your journey to school. Part '+i},responseConfig:{inputType:'text',maxLength:200}}))},
 answers:{q1:{value:'Earlier answer',answeredAt:now}},metadata:{localId:'voice-smoke',origin:'local_source',updatedAt:now}});
});
errors.length=0;
await page.goto(base + '/server/viewer/index.html?localAttemptId=voice-smoke');

const field=()=>page.locator('.question-card > textarea');
// Live editable -> temporarily locked -> completed transition, with real viewer rendering.
assert.equal(await page.getByRole('button',{name:'Add by voice',exact:true}).isVisible(),true);
assert.equal(await page.getByRole('button',{name:'Rewrite',exact:true}).isEnabled(),true);
assert.equal(await page.getByRole('button',{name:'Undo',exact:true}).isDisabled(),true);
await page.getByRole('button',{name:'Add by voice',exact:true}).click();
await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
for(const name of ['Add by voice','Rewrite','Undo']) {
 assert.equal(await page.getByRole('button',{name,exact:true}).isVisible(),true);
 assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
}
assert.equal(await page.locator('.viewer-voice-status:visible').count(),1);
await page.getByRole('button',{name:'Stop',exact:true}).click();
await page.waitForFunction(()=>window.viewerSession.voice.active?.state==='transcribing');
finishTranscription();hold=false;
await page.waitForFunction(()=>window.viewerSession.voice.active?.state==='rewriting');
for(const selector of ['.question-card__voice-btn','.question-card__rewrite-btn','.question-card__undo-btn']) {
 assert.equal(await page.locator(selector).isVisible(),true);
 assert.equal(await page.locator(selector).isDisabled(),true);
}
assert.match(await page.locator('.viewer-voice-status:visible').innerText(),/Rewriting/);
finishRewrite();
await page.waitForFunction(()=>!window.viewerSession.voice.active);
assert.equal(await page.getByRole('button',{name:'Undo',exact:true}).isEnabled(),true);
await page.getByRole('button',{name:'Submit',exact:true}).click();
await page.waitForFunction(()=>window.viewerSession.state.status==='completed'&&!window.viewerSession.state.isFinalizing);
assert.equal(await page.locator('.question-card__text-footer').isVisible(),false);
assert.equal(await field().inputValue(),'Earlier answer New segment');
assert.equal(await field().evaluate(e=>e.readOnly&&!e.disabled),true);

for(const locale of ['en','zh-Hant']) {
 for(const width of [1280,390]) {
  await page.evaluate(async locale=>{
   localStorage.setItem('worksheetLauncher.locale',locale);
   const {viewerStorage}=await import('/server/viewer/storage/index.js');
   const attempt=await viewerStorage.attempts.get('voice-smoke');
   attempt.status='completed'; attempt.lastActiveBlockId='q1'; attempt.lastActiveIndex=0;
   attempt.answers={q1:{value:'My submitted answer. 我的已提交答案。'},q3:{value:7}};
   attempt.viewerPayload.blocks=attempt.viewerPayload.blocks.slice(0,2);
   attempt.viewerPayload.blocks.push({blockId:'q3',kind:'question',position:2,prompt:{text:'Number review'},responseConfig:{inputType:'number',correctAnswer:7,maxLength:20}});
   await viewerStorage.attempts.put(attempt);
  },locale);
  await page.setViewportSize({width,height:width===390?844:900});
  await page.reload();
  await field().waitFor();
  assert.equal(await field().inputValue(),'My submitted answer. 我的已提交答案。');
  assert.equal(await field().evaluate(e=>e.readOnly&&!e.disabled&&!e.hasAttribute('aria-describedby')),true);
  await field().focus();
  assert.equal(await field().evaluate(e=>document.activeElement===e),true);
  for(const selector of ['.question-card__voice-btn','.question-card__rewrite-btn','.question-card__undo-btn','.text-counter','.question-card__rewrite-hint','.viewer-voice-hint'])
   assert.equal(await page.locator(selector).isVisible(),false,selector);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await shot('review-'+locale+'-'+width+'-answered.png');
  await page.evaluate(()=>{window.viewerSession.checkAnswers();});
  assert.equal(await field().inputValue(),'My submitted answer. 我的已提交答案。');
  // Text questions are not automatically graded by the existing viewer.
  assert.equal(await page.locator('.viewer-check-banner').count(),0);
  // Navigate through the existing accessible next-block control.
  await page.getByRole('button',{name:locale==='en'?'Go to next block':'前往下一個區塊',exact:true}).click();
  await page.locator('.question-card__review-status').waitFor();
  assert.equal(await page.locator('.question-card__review-status').innerText(),locale==='en'?'Not answered':'未作答');
  assert.equal(await field().isVisible(),false);
  assert.equal(await page.locator('.question-card__text-footer').isVisible(),false);
  await page.locator('.question-card__review-status').evaluate(e=>e.scrollIntoView({block:'center'}));
  assert.equal(await page.locator('.question-card__review-status').evaluate(e=>e.getBoundingClientRect().bottom<=document.querySelector('.viewer-bottom-bar').getBoundingClientRect().top),true);
  await shot('review-'+locale+'-'+width+'-unanswered.png');
  await page.getByRole('button',{name:locale==='en'?'Go to next block':'前往下一個區塊',exact:true}).click();
  const number=page.locator('.question-card > input');
  assert.equal(await number.inputValue(),'7');
  assert.equal(await number.isDisabled(),true);
  assert.equal(await page.locator('.question-card__review-status').count(),0);
  assert.equal(await page.locator('.viewer-check-banner.is-correct').isVisible(),true);
  assert.equal(await page.locator('.viewer-check-reveal').isVisible(),true);
 }
}
assert.deepEqual(errors,[]);
console.log('PASS editable/processing/completed controls, bilingual unanswered review, read-only focus, check/reveal and number behavior, desktop/mobile overflow and bottom clearance; no browser errors');
} finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
