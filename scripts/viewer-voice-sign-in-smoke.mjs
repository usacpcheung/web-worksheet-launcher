import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const browser=await chromium.launch();
try {
  for(const locale of ['en','zh-Hant']) for(const width of [1280,390]) {
    const context=await browser.newContext({viewport:{width,height:900}});
    const page=await context.newPage(); page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let ready=false, providerCalls=0;
    await page.exposeFunction('fixtureSignIn',()=>{ready=true;});
    await page.route(url=>url.pathname.startsWith('/api/'),route=>{
      if(new URL(route.request().url()).pathname.endsWith('/session')) return route.fulfill({json:ready
        ? {ok:true,data:{user:{sub:'voice-fixture'}}} : {ok:false,error:{code:'AUTH_REQUIRED'}}});
      providerCalls++;return route.fulfill({json:{ok:true,result:'Fixture text',data:{items:[]}}});
    });
    await page.addInitScript(()=>{
      window.fixtureRecordings=0;
      Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{
        window.fixtureRecordings++;return {getTracks:()=>[{stop(){}}]};
      }},configurable:true});
      window.MediaRecorder=class {static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/webm';}
        start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['audio'],{type:'audio/webm'})});this.onstop?.();});}};
    });
    await page.goto(base+'/server/viewer/');
    await page.evaluate(async locale=>{
      localStorage.setItem('worksheetLauncher.locale',locale);
      const {viewerStorage}=await import('/server/viewer/storage/index.js');const now=new Date().toISOString();
      await viewerStorage.attempts.put({localId:'voice-auth',localAttemptId:'voice-auth',status:'in_progress',startedAt:now,lastActiveBlockId:'q1',lastActiveIndex:0,
        viewerPayload:{worksheetId:'auth',snapshotId:'auth',snapshotVersion:1,title:'Voice login test',blocks:[{blockId:'q1',kind:'question',position:0,prompt:{text:'Explain your idea. 說明你的想法。'},responseConfig:{inputType:'text',maxLength:200}}]},
        answers:{q1:{value:'Keep this answer'}},metadata:{localId:'voice-auth',origin:'local_source',updatedAt:now}});
    },locale);
    await page.goto(base+'/server/viewer/?localAttemptId=voice-auth');
    const add=page.locator('.question-card__voice-btn');await add.waitFor();
    await page.evaluate(()=>{window.fixtureLogins=0;window.viewerSession.beginServerSignIn=async()=>{
      window.fixtureLogins++;await window.fixtureSignIn();return {ok:true};
    };});
    const dialog=page.locator('.read-auth-prompt');
    const field=page.locator('.viewer-answer-area > textarea:not(.question-card__review-status)');
    const counts=()=>page.evaluate(()=>({login:window.fixtureLogins,record:window.fixtureRecordings}));
    const cancel=locale==='en'?'Cancel':'取消';const signIn=locale==='en'?'Sign in':'登入';
    const unchanged=async()=>assert.equal(await field.inputValue(),'Keep this answer');
    await add.click();await dialog.waitFor();
    assert.deepEqual(await counts(),{login:0,record:0});assert.equal(providerCalls,0);
    assert.match(await dialog.innerText(),locale==='en'?/press “Add by voice” again/:/再次按「用語音加入」/);
    const rect=await dialog.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=width);
    assert.equal(await dialog.getByRole('button',{name:cancel,exact:true}).evaluate(e=>e===document.activeElement),true);
    await dialog.getByRole('button',{name:cancel,exact:true}).click();await unchanged();
    assert.deepEqual(await counts(),{login:0,record:0});
    await add.click();await dialog.waitFor();await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.deepEqual(await counts(),{login:0,record:0});
    // Whole-answer rewrite uses the same viewer policy and retains recovery text.
    await page.locator('.question-card__rewrite-btn').click();await dialog.waitFor();
    assert.match(await dialog.innerText(),locale==='en'?/rewrite your answer/:/改寫答案/);
    await dialog.getByRole('button',{name:cancel,exact:true}).click();await unchanged();
    assert.equal(await page.evaluate(()=>window.viewerSession.state.voiceRecovery.q1.text),'Keep this answer');
    await page.locator('.viewer-voice-recovery-actions button').last().click();
    await add.click();await dialog.waitFor();await dialog.getByRole('button',{name:signIn,exact:true}).click();
    await page.waitForFunction(()=>window.fixtureLogins===1);await dialog.waitFor({state:'hidden'});
    assert.deepEqual(await counts(),{login:1,record:0});assert.equal(providerCalls,0);await unchanged();
    // Explicit click is required after login; already-ready users have no prompt.
    await add.click();await page.waitForFunction(()=>window.viewerSession.voice.active?.state==='recording');
    assert.equal(await dialog.count(),0);assert.deepEqual(await counts(),{login:1,record:1});
    await page.locator('.viewer-voice-status').getByRole('button',{name:cancel,exact:true}).click();
    await page.waitForFunction(()=>!window.viewerSession.voice.active);await unchanged();
    // A now-completed attempt invalidates an open prompt without starting login.
    await page.locator('.viewer-voice-recovery-actions button').last().click();
    ready=false;await add.click();await dialog.waitFor();
    await page.evaluate(()=>{window.viewerSession.state.status='completed';window.viewerSession.notifyStateChange();});
    await dialog.waitFor({state:'hidden'});assert.deepEqual(await counts(),{login:1,record:1});
    // Shared consumers without the viewer policy retain their existing behavior.
    const fallbackLogins = await page.evaluate(async()=>{
      const {createVoiceControls}=await import('/server/viewer/answer-voice-ui.js');
      let calls=0;
      const session={state:{status:'in_progress',answers:{},voiceRecovery:{}},
        voice:{active:null,run:async()=>({error:{code:'AUTH_REQUIRED'}})},beginServerSignIn:()=>{calls++;}};
      const control=document.createElement('textarea');
      const ui=createVoiceControls({session,control,block:{blockId:'shared',responseConfig:{maxLength:200}},
        t:key=>key,view(){},applied(){},signal:new AbortController().signal});
      ui.add.click();await new Promise(resolve=>setTimeout(resolve,0));return calls;
    });
    assert.equal(fallbackLogins,1);
    assert.deepEqual(errors,[]);await context.close();
    console.log(`PASS viewer voice sign-in confirmation ${locale} ${width}px`);
  }
} finally {await browser.close();}
