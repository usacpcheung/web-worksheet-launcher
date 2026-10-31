import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base=process.env.VIEWER_SMOKE_URL||'http://127.0.0.1:8765', shots=process.env.VIEWER_SMOKE_SCREENSHOTS;
const browser=await chromium.launch();
try {
 for(const width of [1280,390]) {
  const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/server/viewer/');
  await page.evaluate(async()=>{
   const {viewerStorage}=await import('/server/viewer/storage/index.js');const now=new Date().toISOString();
   const texts=[
    '## Healthy routines\n### Read and consider\nA healthy routine includes enough sleep, balanced meals and regular exercise. Think about what you do every day.\n\n#### Your answer\n- Explain your choice.\n- Give an example.',
    '## 健康的生活習慣\n### 閱讀並思考\n健康的生活習慣包括充足睡眠、均衡飲食和適量運動。想一想你每天的生活，選擇最適合的答案。\n\n#### 你的答案\n- 解釋你的選擇。\n- 舉出一個例子。',
    '## 每天的習慣 Daily routines\n### 閱讀 Read\n每天睡眠 8 小時（8 hours），並安排適量 exercise。Think about your routine，再回答以下問題。\n\n#### 回答 Answer\n> 先思考，再回答。Think before answering.'];
   const blocks=texts.map((text,i)=>({blockId:'q'+i,kind:'question',position:i,prompt:{text,format:'limited-markdown-v1',audioTracks:[{language:'english',assetId:'a',sourceTextHash:'fixture'},{language:'cantonese',assetId:'b',sourceTextHash:'fixture'}]},responseConfig:{inputType:'text'}}));
   await viewerStorage.attempts.put({localId:'prompt-layout',localAttemptId:'prompt-layout',status:'in_progress',startedAt:now,viewerPayload:{worksheetId:'fixture',snapshotId:'fixture',snapshotVersion:1,title:'Prompt typography trial',blocks},answers:{},metadata:{localId:'prompt-layout',origin:'local_source',updatedAt:now}});
  });
  await page.goto(base+'/server/viewer/?localAttemptId=prompt-layout');
  await page.locator('.question-card__prompt-row').first().waitFor();await page.evaluate(()=>document.fonts.ready);
  for(const row of await page.locator('.question-card__prompt-row').all()) {
   await row.scrollIntoViewIfNeeded();
   const trigger=row.locator('.viewer-audio-control__trigger');await trigger.click();
   const geometry=await row.evaluate(n=>{
    const text=n.querySelector('.question-card__prompt-text').getBoundingClientRect(),audio=n.querySelector('.viewer-audio-control').getBoundingClientRect(),menu=n.querySelector('.viewer-audio-control__menu').getBoundingClientRect();
    return {textRight:text.right,audioLeft:audio.left,topDelta:Math.abs(text.top-audio.top),menuLeft:menu.left,menuRight:menu.right};
   });
   assert(geometry.textRight<=geometry.audioLeft);assert(geometry.topDelta<2);
   assert(geometry.menuLeft>=0&&geometry.menuRight<=width);
   await page.keyboard.press('Escape');
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(shots) {
   await page.screenshot({path:`${shots}/prompts-${width}-1.6.png`,fullPage:true});
   // Comparison artifacts only: never saved to application source or storage.
   for(const spacing of [1.5,1.65]) {
    await page.locator('.question-card__prompt-label').evaluateAll((nodes,spacing)=>nodes.forEach(n=>n.style.lineHeight=spacing),String(spacing));
    await page.screenshot({path:`${shots}/prompts-${width}-${spacing}.png`,fullPage:true});
   }
  }
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('English, Chinese and mixed prompts: top-right audio, inward menus, responsive hierarchy and spacing comparison');
}finally{await browser.close();}
