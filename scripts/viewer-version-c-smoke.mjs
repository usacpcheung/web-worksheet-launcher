import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openViewerActions, chooseViewerSection, clickViewerAction } from './viewer-navigation-test-helpers.mjs';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, {recursive:true});
const browser = await chromium.launch();
try {
 for (const locale of ['en','zh-Hant']) {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[];page.on('pageerror', e=>errors.push(e.message));
  await page.addInitScript(()=>{ window.Audio = class extends EventTarget { play(){return Promise.resolve();} pause(){} load(){} removeAttribute(){} }; });
  await page.route(url=>url.pathname.startsWith('/api/'), route=>route.fulfill({json:{ok:true,data:{user:{sub:'fixture'},items:[]}}}));
  await page.goto(base+'/server/viewer/');
  await page.evaluate(async locale=>{
   localStorage.setItem('worksheetLauncher.locale',locale);
   const {viewerStorage}=await import('/server/viewer/storage/index.js');
   const now=new Date().toISOString();
   for(const id of ['audio','audio2']) await viewerStorage.localAssets.put({localId:id,binary:new Uint8Array([1]),metadata:{localId:id,origin:'local_source',updatedAt:now,mimeType:'audio/mpeg'}});
   const tracks=[{language:'english',assetId:'audio',sourceTextHash:'fixture'},{language:'cantonese',assetId:'audio2',sourceTextHash:'fixture'}];
   const blocks=Array.from({length:20},(_,position)=>{
    const blockId='b'+position;
    if(position%5===0)return {blockId,position,kind:'content',content:{text:'Reading section 閱讀資料 '+position+'\n'+('Keep a healthy routine. 保持健康生活。 ').repeat(8)}};
    const inputType=['text','number','boolean','multiple_choice'][(position-1)%4];
    return {blockId,position,kind:'question',prompt:{text:'How can we maintain a healthy lifestyle? 如何保持健康的生活？ '+position,audioTracks:(position===1||position===6)?tracks:position===2?tracks.slice(0,1):[]},responseConfig:{inputType,maxLength:200,selectionMode:'single',options:['Sleep','Skip meals','Exercise'].map((label,i)=>({id:'o'+i,value:'v'+i,label,audioTracks:i===0?tracks:i===1?tracks.slice(0,1):[]}))}};
   });
   await viewerStorage.attempts.put({localId:'version-c',localAttemptId:'version-c',status:'in_progress',startedAt:now,lastActiveBlockId:'b0',lastActiveIndex:0,viewerPayload:{worksheetId:'fixture',snapshotId:'fixture',snapshotVersion:1,title:'Healthy habits 健康生活',blocks},answers:{b2:{value:0},b3:{value:false}},metadata:{localId:'version-c',origin:'local_source',updatedAt:now}});
  },locale);
  await page.goto(base+'/server/viewer/?localAttemptId=version-c');
  await page.locator('.viewer-browse').waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('.viewer-section-label').count(),20);
  assert.deepEqual(await page.locator('.viewer-section-label').allTextContents(),Array.from({length:20},(_,i)=>i%5===0?(locale==='en'?`Reading ${i/5+1}`:`閱讀 ${i/5+1}`):(locale==='en'?`Question ${i-Math.floor(i/5)}`:`第 ${i-Math.floor(i/5)} 題`)));
  assert.equal(await page.locator('.viewer-progress-count').innerText(),locale==='en'?'Answered 2/16':'已作答 2/16');
  assert.deepEqual(await page.locator('.viewer-question-number').allTextContents(),Array.from({length:16},(_,i)=>String(i+1).padStart(2,'0')));
  assert.equal(await page.locator('.viewer-answer-area .viewer-question-heading').count(),0,'question identity stays with the prompt, outside the answer area');
  assert.equal(await page.locator('[data-block-id="b4"] .viewer-question-kind').innerText(),locale==='en'?'Single choice':'單項選擇');
  // Equal answer surfaces, reserved audio column, single/multi track size parity.
  const sizes=await page.locator('[data-block-id="b4"] .choice-button-group__row').evaluateAll(rows=>rows.map(r=>({answer:r.firstElementChild.getBoundingClientRect().width,audio:r.querySelector('.viewer-audio-control__trigger')?.getBoundingClientRect().width})));
  assert(sizes.every(r=>Math.abs(r.answer-sizes[0].answer)<1));
  assert.equal(sizes[0].audio,sizes[1].audio);
  const bool=await page.locator('[data-block-id="b3"] .boolean-segmented-control__button').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));
  assert(Math.abs(bool[0]-bool[1])<1);
  if(shots)await page.screenshot({path:`${shots}/layout-${locale}.png`});
  for (const width of [1280,320]) {
   await page.setViewportSize({width,height:900});
   await chooseViewerSection(page,1);
   const geometry=await page.locator('[data-block-id="b1"]').evaluate(section=>{
    const bounds=selector=>section.querySelector(selector).getBoundingClientRect();
    const number=bounds('.viewer-question-number'), heading=bounds('.viewer-question-heading'), prompt=bounds('.question-card__prompt-row');
    return {numberLeft:number.left,numberRight:number.right,headingLeft:heading.left,headingBottom:heading.bottom,promptTop:prompt.top,overflow:document.documentElement.scrollWidth-innerWidth};
   });
   assert(geometry.numberLeft>=0&&geometry.numberRight<=geometry.headingLeft&&geometry.headingBottom<=geometry.promptTop&&geometry.overflow<=0,JSON.stringify(geometry));
   if(width===320) assert(await page.evaluate(()=>{
    const edge=document.querySelector('.viewer-actions-launcher').getBoundingClientRect().left;
    return [...document.querySelectorAll('.viewer-answer-area > input, .viewer-answer-area > textarea, .choice-button-group__item, .boolean-segmented-control')]
     .filter(node=>!node.hidden).every(node=>node.getBoundingClientRect().right<=edge-4);
   }),'answer controls retain clearance from the floating launcher throughout scrolling');
   const prompt=page.locator('[data-block-id="b1"] .viewer-audio-control--question');
   assert.equal(await prompt.locator('.viewer-audio-control__trigger').innerText(),'','prompt playback stays icon-only');
   const audioDimensions=await page.locator('[data-block-id="b1"] .viewer-audio-control__trigger, [data-block-id="b2"] .viewer-audio-control__trigger, [data-block-id="b4"] .viewer-audio-control__trigger').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return [r.width,r.height];}));
   assert(audioDimensions.every(([w,h])=>w===50&&h===44),'single/multiple prompt and option audio keep the same compact size');
   await prompt.locator('button').first().click();
   assert(await prompt.locator('.viewer-audio-control__menu').evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),'prompt language menu stays within viewport');
   assert.equal(await prompt.locator('.viewer-audio-control__menu-item').count(),2);
   await prompt.locator('.viewer-audio-control__menu-item').last().click();
   await page.waitForFunction(()=>Boolean(window.viewerSession.activeAudio));
   await prompt.locator('button').first().click();
   assert.equal(await page.evaluate(()=>Boolean(window.viewerSession.activeAudio)),false);
   await chooseViewerSection(page,4);
   const option=page.locator('[data-block-id="b4"] .viewer-audio-control--option').first();
   await option.locator('button').first().click();
   assert(await option.locator('.viewer-audio-control__menu').evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),'option language menu stays within viewport');
   await option.locator('.viewer-audio-control__menu-item').first().click();
   await page.waitForFunction(()=>Boolean(window.viewerSession.activeAudio));
   await chooseViewerSection(page,0);
   assert.equal(await page.evaluate(()=>Boolean(window.viewerSession.activeAudio)),false,'section change stops option playback');
  }
  // Acceptance regression: menus near either vertical edge must remain reachable.
  for (const viewport of [{width:1280,height:900},{width:320,height:225}]) {
   await page.setViewportSize(viewport);
   for (const [index,kind] of [[6,'question'],[4,'option']]) for (const edge of ['bottom','top']) {
    await chooseViewerSection(page,index);
    const root=page.locator(`[data-block-id="b${index}"] .viewer-audio-control--${kind}`).first();
    const trigger=root.locator('.viewer-audio-control__trigger');
    await trigger.evaluate((node,edge)=>window.scrollBy(0,node.getBoundingClientRect().top-(edge==='bottom'?innerHeight-104:12)),edge);
    await trigger.click();
    const menu=root.locator('.viewer-audio-control__menu');
    const contained=()=>menu.evaluate(node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:innerWidth,height:innerHeight};});
    let r=await contained();
    assert(r.top>=0&&r.bottom<=r.height&&r.left>=0&&r.right<=r.width,JSON.stringify({locale,kind,edge,r}));
    if (shots && edge==='bottom') await page.screenshot({path:`${shots}/audio-menu-${locale}-${kind}-${viewport.width}.png`});
    await page.evaluate(()=>window.scrollBy(0,10));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    r=await contained();
    assert(r.top>=0&&r.bottom<=r.height&&r.left>=0&&r.right<=r.width,JSON.stringify({scrolled:true,locale,kind,edge,r}));
    // A resize while open must reposition without dismissing or stealing focus.
    await page.setViewportSize({width:viewport.width,height:viewport.height-30});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    r=await contained();
    assert(r.top>=0&&r.bottom<=r.height&&r.left>=0&&r.right<=r.width,JSON.stringify({resized:true,locale,kind,edge,r}));
    assert(await menu.locator('button').first().evaluate(node=>node===document.activeElement));
    if (viewport.height===225) {
     // Enlarged language rows force the constrained-height scrolling fallback.
     await menu.locator('button').evaluateAll(nodes=>nodes.forEach(node=>node.style.minHeight='100px'));
     await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
     const last=menu.locator('button').last();
     await last.focus();
     await menu.evaluate(node=>node.scrollTop=node.scrollHeight);
     await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
     assert(await menu.evaluate(node=>node.scrollTop>0),'menu scrolling is not reset by positioning');
     assert(await last.evaluate(node=>{const r=node.getBoundingClientRect(),m=node.parentElement.getBoundingClientRect();return r.bottom<=m.bottom+1;}),'last language is reachable');
     await menu.locator('button').evaluateAll(nodes=>nodes.forEach(node=>node.style.minHeight=''));
    }
    await page.keyboard.press('Escape');
    assert(await trigger.evaluate(node=>node===document.activeElement));
    await page.setViewportSize(viewport);
   }
  }
  await chooseViewerSection(page,0);
  for(const viewport of [{width:1280,height:900},{width:390,height:844},{width:320,height:568},{width:740,height:360},{width:640,height:450},{width:320,height:225}]) {
   await page.setViewportSize(viewport);
   if(await page.locator('.viewer-actions-launcher').isVisible()) assert(await page.locator('.viewer-actions-launcher').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight));
   await openViewerActions(page);
   const current=await page.evaluate(()=>window.viewerSession.state.lastActiveBlockId);
   await page.locator('.viewer-browse').click();
   assert.equal(await page.locator('dialog[open]').count(),1);
   const backgroundScroll = await page.evaluate(()=>scrollY);
   await page.mouse.move(1,1);
   await page.mouse.wheel(0,1200);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.evaluate(()=>scrollY),backgroundScroll,'modal backdrop cannot move the worksheet');
   assert.equal(await page.evaluate(()=>window.viewerSession.state.lastActiveBlockId),current);
   // Traverse every section exactly once, including short and 200/400% equivalent CSS viewports.
   const seen=[];
   while(true){
    const visible=page.locator('.viewer-chooser__item:visible');
    seen.push(...await visible.evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.sectionIndex))));
    const bounds=await page.locator('.viewer-chooser').evaluate(node=>({top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom,height:innerHeight,overflow:node.scrollHeight-node.clientHeight,width:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert(bounds.top>=0&&bounds.bottom<=bounds.height+1,JSON.stringify(bounds));
    assert(bounds.overflow<=1,JSON.stringify(bounds));
    assert(bounds.width<=bounds.viewport,JSON.stringify(bounds));
    if(await page.locator('.viewer-chooser__next').isDisabled())break;
    await page.locator('.viewer-chooser__next').click();
   }
   assert.deepEqual(seen,Array.from({length:20},(_,i)=>i));
   await page.keyboard.press('Escape');
   assert(await page.evaluate(()=>document.activeElement.matches('.viewer-browse,.viewer-actions-launcher')));
   await openViewerActions(page);
   await page.locator('.viewer-browse').click();
   const first=page.locator('.viewer-chooser__item').first();
   await first.evaluate(node=>{window.chooserRow=node;node.focus();});
   await page.evaluate(()=>window.viewerSession.notifyStateChange());
   assert(await first.evaluate(node=>node===window.chooserRow&&node===document.activeElement));
   // Hover is stationary even when status refreshes.
   const before=await first.boundingBox();await first.hover();
   await page.evaluate(()=>window.viewerSession.notifyStateChange());
   assert.deepEqual(await first.boundingBox(),before);
   if(shots)await page.screenshot({path:`${shots}/chooser-${locale}-${viewport.width}-${viewport.height}.png`});
   await page.keyboard.press('Escape');
  }
  // Enlarged text uses measured row heights; resize keeps the focused item.
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{document.documentElement.style.fontSize='32px';});
  await page.setViewportSize({width:320,height:568});
  assert(await page.locator('.viewer-question-number').evaluateAll(nodes=>nodes.every(node=>{
   const number=node.getBoundingClientRect(),heading=node.parentElement.getBoundingClientRect();
   return number.left>=0&&number.right<=heading.left;
  })),'decorative margin numbers remain visible with enlarged document text');
  await page.setViewportSize({width:390,height:844});
  await openViewerActions(page);
  await page.locator('.viewer-browse').click();
  await page.locator('.viewer-chooser__item').first().focus();
  await page.setViewportSize({width:320,height:568});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert(await page.locator('.viewer-chooser__item').first().evaluate(node=>node===document.activeElement&&!node.hidden));
  assert(await page.locator('.viewer-chooser').evaluate(node=>node.getBoundingClientRect().top>=0&&node.getBoundingClientRect().bottom<=innerHeight+1&&node.scrollHeight<=node.clientHeight+1));
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{document.documentElement.style.fontSize='';});
  await page.setViewportSize({width:390,height:844});
  await chooseViewerSection(page,19);
  assert.equal(await page.evaluate(()=>window.viewerSession.state.lastActiveBlockId),'b19');
  assert.equal(await page.locator('dialog[open]').count(),0);
  assert(await page.locator('[data-block-id="b19"]').evaluate(node=>node===document.activeElement));
  await openViewerActions(page);
  await page.locator('.viewer-browse').click();
  assert(await page.locator('[data-section-index="19"]').evaluate(node=>!node.hidden&&node===document.activeElement));
  await page.keyboard.press('Escape');
  await clickViewerAction(page,locale==='en'?'Previous section':'上一節');
  assert.equal(await page.evaluate(()=>window.viewerSession.state.lastActiveBlockId),'b18');
  await clickViewerAction(page,locale==='en'?'Save':'儲存');
  await page.waitForFunction(()=>!window.viewerSession.state.autosavePending);
  assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('Version C layout/navigation acceptance passed');
}finally{await browser.close();}
