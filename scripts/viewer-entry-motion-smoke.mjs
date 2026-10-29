import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chooseViewerSection } from './viewer-navigation-test-helpers.mjs';
const base=process.env.VIEWER_SMOKE_URL||'http://127.0.0.1:8765';
const browser=await chromium.launch();
try {
 for(const width of [1280,390]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route(url=>url.pathname.startsWith('/api/'),r=>r.fulfill({json:{ok:true,data:{items:[]}}}));
  await page.goto(base+'/server/viewer/');
  await page.evaluate(async()=>{
   const {viewerStorage}=await import('/server/viewer/storage/index.js');const now=new Date().toISOString();
   await viewerStorage.attempts.put({localId:'motion',localAttemptId:'motion',status:'in_progress',startedAt:now,lastActiveBlockId:'q0',lastActiveIndex:0,viewerPayload:{worksheetId:'w',snapshotId:'s',snapshotVersion:1,title:'Motion fixture',blocks:Array.from({length:6},(_,position)=>({blockId:'q'+position,position,kind:'question',prompt:{text:'Question 題目 '+position},responseConfig:{inputType:'text',maxLength:200}}))},answers:{},metadata:{localId:'motion',origin:'local_source',updatedAt:now}});
  });
  await page.goto(base+'/server/viewer/?localAttemptId=motion');
  await page.locator('#answer-q0').waitFor();await page.evaluate(()=>document.fonts.ready);
  await page.mouse.move(1,1);
  await page.evaluate(()=>{const node=document.querySelector('[data-block-id="q3"] .question-card__prompt-row');window.scrollTo(0,scrollY+node.getBoundingClientRect().top-innerHeight*.75);});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const prompt=page.locator('[data-block-id="q3"] .question-card__prompt-row');
  assert(await prompt.evaluate(n=>n.style.filter.startsWith('blur(')));
  assert(await prompt.evaluate(n=>n.getAnimations().some(a=>a.id==='viewer-entry-prompt')));
  await chooseViewerSection(page,3);
  assert.equal(await prompt.evaluate(n=>n.style.filter),'');
  assert.equal(await prompt.evaluate(n=>n.getAnimations().length),0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.locator('#viewer-answer-form').evaluate(n=>n.getAnimations({subtree:true}).filter(a=>a.id.startsWith('viewer-entry-')).length),0);
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Motion checks passed');
}finally{await browser.close();}
