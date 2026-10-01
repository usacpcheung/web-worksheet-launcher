import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const base=process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots=process.env.VIEWER_SMOKE_SCREENSHOTS;
if(shots) await mkdir(shots,{recursive:true});
const browser=await chromium.launch();
try {
 for(const locale of ['en','zh-Hant']) for(const width of [1280,390]) {
  const context=await browser.newContext({viewport:{width,height:1000}});
  try {
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/voice-authoring-fixture',r=>r.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/server/roleplayscene/styles/app.css"><main id="left"></main><aside id="right"></aside>'}));
   await page.goto(base+'/voice-authoring-fixture');
   await page.evaluate(async locale=>{
    const {Store}=await import('/server/roleplayscene/scripts/state.js');
    const {createProject}=await import('/server/roleplayscene/scripts/model.js');
    const {renderEditor}=await import('/server/roleplayscene/scripts/editor/editor.js');
    const {setActiveLocale}=await import('/server/roleplayscene/scripts/i18n.js');setActiveLocale(locale);
    const store=new Store();store.setLocale(locale);
    store.set({project:createProject({speakers:[{id:'alex',name:'Alex'},{id:'sam',name:'Sam'}],scenes:[
     {id:'first',type:'start',dialogue:[{text:'One',speakerId:'alex'},{text:'Two',speakerId:'alex',voiceChoice:'cantonese_female_1'},{text:'Custom',audio:{name:'recording.mp3'}}],choices:[{id:'next',label:'Next',nextSceneId:'later'}]},
     {id:'later',type:'end',dialogue:[{text:'Later',speakerId:'alex'}]}
    ]})});
    window.voiceStore=store;window.voiceCalls=[];window.signIns=0;window.voiceFailure=false;
    window.mountVoiceEditor=(scene='first')=>{
     window.disposeVoiceEditor?.();
     window.disposeVoiceEditor=renderEditor(store,document.querySelector('#left'),document.querySelector('#right'),()=>{}, {
      initialSelectedSceneId:scene,ensureServerSessionReady:async()=>({ok:true}),onSignIn:()=>window.signIns++,
      apiClient:{generateAudioFromText:async(text,options)=>{window.voiceCalls.push({text,options});return window.voiceFailure ? {ok:false,error:{status:401,requiresSignIn:true,message:'Expired'}} : {ok:true,data:new Uint8Array([1,2,3])};}}
     });
    };window.mountVoiceEditor();
   },locale);
   const voice=(scene,index)=>page.locator(`[data-focus-key="dialogue-t2a-preset-${scene}-${index}"]`);
   await voice('first',0).selectOption('cantonese_male_3');
   assert.equal(await voice('first',1).inputValue(),'cantonese_female_1');
   await page.evaluate(()=>window.mountVoiceEditor('later'));
   assert.equal(await voice('later',0).inputValue(),'cantonese_male_3');
   await voice('later',0).selectOption('cantonese_female_3');
   await page.evaluate(()=>window.mountVoiceEditor());
   assert.equal(await voice('first',0).inputValue(),'cantonese_male_3');
   assert.equal(await voice('first',1).inputValue(),'cantonese_female_1');
   assert.ok(await page.getByText(locale==='en'?'Custom voice':'自訂聲音',{exact:true}).count());
   await page.locator('[data-focus-key="dialogue-move-first-1--1"]').click();
   assert.equal(await voice('first',0).inputValue(),'cantonese_female_1');
   assert.equal(await voice('first',1).inputValue(),'cantonese_male_3');
   await page.evaluate(async()=>{
    const {serializeProject,hydrateProject,createProjectArchive,extractProjectFromArchive}=await import('/server/roleplayscene/scripts/storage.js');
    const restored=hydrateProject(serializeProject(window.voiceStore.get().project));
    const {archiveData}=await createProjectArchive(restored);
    window.voiceStore.set({project:hydrateProject(await extractProjectFromArchive(archiveData))});
    window.mountVoiceEditor();
   });
   assert.equal(await voice('first',1).inputValue(),'cantonese_male_3');
   assert.equal(await page.evaluate(()=>window.voiceStore.get().project.speakers[0].lastVoiceChoice),'cantonese_female_3');
   // An expiry must keep selection, expose sign-in, and never auto-retry.
   await page.evaluate(()=>window.voiceFailure=true);
   await page.locator('.dialogue-t2a-controls button').nth(1).click();
   const notice=locale==='en'?'Session expired. Existing audio is unchanged. Sign in, then press Generate again.':'登入已過期，原有音訊未有更改。請重新登入，再按「生成」。';
   await page.getByText(notice,{exact:true}).waitFor();
   await page.getByRole('button',{name:locale==='en'?'Sign in':'登入',exact:true}).click();
   assert.equal(await page.evaluate(()=>window.signIns),1);
   assert.equal(await page.evaluate(()=>window.voiceCalls.length),1);
   assert.equal(await voice('first',1).inputValue(),'cantonese_male_3');
   // All seven labels stay short; keyboard can reach the selector.
   assert.equal(await voice('first',1).locator('option').count(),7);
   assert.equal(await voice('first',1).evaluate(el=>Array.from(el.options).every(o=>o.text.length<=8)),true);
   await voice('first',1).focus();assert.equal(await voice('first',1).evaluate(el=>el===document.activeElement),true);
   if(shots)await page.screenshot({path:`${shots}/roleplay-voices-${locale}-${width}.png`,fullPage:true});
   assert.deepEqual(errors,[]);
   console.log(`PASS ${locale} ${width}: speaker memory, explicit selections, reorder, ZIP, custom badge, expiry and manual retry`);
  } finally {await context.close();}
 }
} finally {await browser.close();}
