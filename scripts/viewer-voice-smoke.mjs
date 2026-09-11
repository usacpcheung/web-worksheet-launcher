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
let failRewrite=false; let transcriptions=0;
let finishTranscription;let hold=true;
await page.route(url => url.pathname.startsWith('/api/'),async route=>{
 const url=route.request().url();
 if(url.endsWith('/session')) return route.fulfill({json:{ok:true,data:{user:{sub:'fixture',name:'Test learner'}}}});
 if(url.endsWith('/transcriptions')) {transcriptions++;if(hold)await new Promise(r=>{finishTranscription=r});return route.fulfill({json:{ok:true,result:'synthetic segment'}});}
 if(url.endsWith('/rewrite'))return route.fulfill({json:failRewrite ? {ok:false,error:{code:'UPSTREAM_FAILED'}} : {ok:true,result:'New segment'}});
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
await page.getByRole('button',{name:'Add by voice',exact:true}).click();
await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
await shot('voice-recording-desktop.png');

assert.equal(await page.locator('.question-card > textarea').evaluate(e=>e.readOnly),true);
assert.equal(await page.getByRole('button',{name:'Submit',exact:true}).isDisabled(),true);
await page.getByRole('button',{name:'Go to next block',exact:true}).click();
await page.waitForFunction(()=>window.viewerSession.voice.active?.state==='transcribing');
assert.equal(await page.locator('.question-card > textarea').evaluate(e=>e.readOnly),false);
await page.locator('.question-card > textarea').fill('Question two typing');
assert.equal(await page.getByRole('button',{name:'Add by voice',exact:true}).isDisabled(),true);
assert.equal(await page.getByRole('button',{name:'Rewrite',exact:true}).isDisabled(),true);
await page.setViewportSize({width:390,height:844});
await page.locator('.viewer-voice-status:visible').evaluate(e=>e.scrollIntoView({block:'center'}));
await shot('voice-other-question-mobile.png');
finishTranscription();hold=false;
await page.waitForFunction(()=>!window.viewerSession.voice.active);
assert.equal(await page.locator('.question-card > textarea').inputValue(),'Question two typing');
assert.equal(await page.locator('.question-card > textarea').evaluate(e=>e===document.activeElement),true);
assert.equal(await page.evaluate(()=>window.viewerSession.state.answers.q1.value),'Earlier answer New segment');
await page.getByRole('button',{name:'Go to previous block',exact:true}).click();
await page.getByRole('button',{name:'Undo',exact:true}).click();
assert.equal(await page.locator('.question-card > textarea').inputValue(),'Earlier answer');
await page.locator('.question-card > textarea').click();
await page.locator('.question-card > textarea').evaluate(e=>{e.setSelectionRange(0,7);e.dispatchEvent(new Event('select'));});
await page.getByRole('button',{name:'Add by voice',exact:true}).click();
await page.getByRole('button',{name:'Stop',exact:true}).click();
await page.waitForFunction(()=>!window.viewerSession.voice.active);
assert.equal(await page.locator('.question-card > textarea').inputValue(),'Earlier New segment answer');
assert.equal(await page.locator('.question-card > textarea').evaluate(e=>e.readOnly),false);
await shot('voice-ready-mobile.png');

assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), true);
failRewrite=true;
await page.getByRole('button',{name:'Add by voice',exact:true}).click();
await page.getByRole('button',{name:'Stop',exact:true}).click();
await page.waitForFunction(()=>!window.viewerSession.voice.active);
assert.equal(await page.getByLabel('Recovered text').inputValue(), 'synthetic segment');
const count=transcriptions;
await page.getByLabel('Recovered text').fill('x'.repeat(2001));
assert.equal(await page.getByRole('button',{name:'Retry rewrite',exact:true}).isDisabled(),true);
await page.getByLabel('Recovered text').fill('shortened transcript');
assert.equal(await page.getByRole('button',{name:'Retry rewrite',exact:true}).isEnabled(),true);
await page.evaluate(()=>window.viewerSession.autosave());
await page.reload();
await page.getByLabel('Recovered text').waitFor();
assert.equal(await page.getByLabel('Recovered text').inputValue(),'shortened transcript');
await page.getByLabel('Recovered text').evaluate(e=>e.scrollIntoView({block:'center'}));
await shot('voice-recovery-mobile.png');
failRewrite=false;
await page.getByRole('button',{name:'Retry rewrite',exact:true}).click();
await page.waitForFunction(()=>!window.viewerSession.voice.active);
assert.equal(transcriptions,count);
assert.equal(await page.locator('.question-card > textarea').inputValue(),'Earlier New segment answer New segment');
await page.locator('.question-card > textarea').fill('Edited after voice');
await page.getByRole('button',{name:'Go to next block',exact:true}).click();
await page.getByRole('button',{name:'Go to previous block',exact:true}).click();
assert.equal(await page.locator('.question-card > textarea').inputValue(),'Edited after voice');
assert.deepEqual(errors, []);
console.log('PASS cross-question completion, focus, selection insertion, undo, mobile width, recovery editing and reload, rewrite-only retry; no browser errors');

} finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});