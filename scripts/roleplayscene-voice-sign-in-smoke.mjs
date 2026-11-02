// Real player UI, isolated storage, synthetic microphone and processing only.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.VIEWER_SMOKE_URL || 'http://127.0.0.1:8765';
const shots = process.env.VIEWER_SMOKE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-Hant']) for (const width of [1280, 390]) for (const bubble of [false, true]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/voice-fixture', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/server/roleplayscene/styles/app.css"><main id="left"></main><div id="right"></div>' }));
    await page.goto(base + '/voice-fixture');
    await page.evaluate(async ({ locale, bubble }) => {
      const { setLocale } = await import('/server/app/i18n/index.js'); setLocale(locale);
      const { renderPlayer } = await import('/server/roleplayscene/scripts/player/player.js');
      const { RolePlaySceneDiscussionSession } = await import('/server/roleplayscene/scripts/player/discussion-state.js');
      window.musicInstances = [];
      window.Audio = class {
        constructor(src) { this.src = src; this.paused = true; window.musicInstances.push(this); }
        play() { this.paused = false; return Promise.resolve(); }
        pause() { this.paused = true; }
      };
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true });
      window.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['synthetic']) }); this.onstop?.(); }); } };
      const apiClient = { transcribeAudio: () => new Promise(resolve => { window.finishTranscript = () => resolve({ ok: true, data: { text: 'new segment' } }); }), rewriteText: async text => window.failRewrite ? { ok: false, error: { code: 'UPSTREAM_FAILED' } } : ({ ok: true, data: { text } }) };
      const project = { meta: { title: 'Voice practice' }, speakers: [], scenes: ['one', 'two'].map((id, i) => ({ id, type: i ? 'end' : 'start', dialogue: [{ text: 'Discuss your choice.' }], choices: i ? [] : [{ id: 'next', label: 'Next scene', nextSceneId: 'two', cueCardText: 'Explain your choice.' }], speechBubble: { enabled: bubble } })) };
      project.scenes[0].backgroundAudio = { objectUrl: 'synthetic-music' };
      const data = { project, audioGate: true }; const listeners = new Set();
      const store = { get: () => data, set: update => { Object.assign(data, update); for (const fn of listeners) fn(); }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
      window.redrawPlayer = () => store.set({ audioGate: false });
      window.authReady=false;window.loginCalls=0;window.captureCalls=0;
      const originalCapture=navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia=async()=>{window.captureCalls++;return originalCapture();};
      const readiness=async()=>window.authReady?{ok:true,isCurrent:()=>true}:{ok:false,error:{code:'AUTH_REQUIRED',status:401}};
      window.discussion = new RolePlaySceneDiscussionSession({checkSession:readiness,
        beginSignIn:async()=>{window.loginCalls++;window.authReady=true;return {ok:true};},
        getProviderAuth:()=>({ensure:readiness}),apiClient}); window.discussion.bindProject(project);
      window.discussion.setText('one', 'Earlier discussion');
      window.cleanupPlayer = renderPlayer(store, document.querySelector('#left'), document.querySelector('#right'), () => {}, { initialSceneId: 'one', discussionSession: window.discussion, apiClient });
    }, { locale, bubble });
    if (bubble) {
      await page.getByRole('button', { name: locale === 'en' ? 'Choices' : '選項', exact: true }).click();
      await page.locator('.player-choice-cue-trigger').click();
    } else {
      await page.locator('.theater-utilities-toggle').click();
      await page.locator('.theater-utilities-section--discussion button').first().click();
    }
    const field=page.locator('.player-discussion-textarea');
    const add=page.locator('.player-discussion-actions .question-card__voice-btn');
    const dialog=page.locator('.read-auth-prompt');
    const cancel=locale==='en'?'Cancel':'取消';
    const signIn=locale==='en'?'Sign in':'登入';
    const unchanged=async()=>assert.equal(await field.inputValue(),'Earlier discussion');
    const counts=()=>page.evaluate(()=>[window.loginCalls,window.captureCalls]);
    await add.click();await dialog.waitFor();
    assert.deepEqual(await counts(),[0,0]);
    assert.match(await dialog.innerText(),locale==='en'?/discussion will be kept/:/保留你的討論內容/);
    const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
    await dialog.getByRole('button',{name:cancel,exact:true}).click();await unchanged();
    await add.click();await dialog.waitFor();await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});assert.equal(await field.isVisible(),true,'Escape closes only the login prompt');await unchanged();
    // Rewrite uses the same consent policy without dropping recovery content.
    await page.getByRole('button',{name:locale==='en'?'Rewrite':'重寫',exact:true}).click();await dialog.waitFor();
    assert.match(await dialog.innerText(),locale==='en'?/rewrite your discussion/:/重寫討論內容/);
    await dialog.getByRole('button',{name:cancel,exact:true}).click();await unchanged();
    assert.equal(await page.evaluate(()=>window.discussion.recovery.one.text),'Earlier discussion');
    await page.locator('.viewer-voice-recovery-actions button').last().click();
    await add.click();await dialog.waitFor();await dialog.getByRole('button',{name:signIn,exact:true}).click();
    await page.waitForFunction(()=>window.loginCalls===1);assert.deepEqual(await counts(),[1,0]);await unchanged();
    await add.click();await page.waitForFunction(()=>window.discussion.voice.active?.state==='recording');
    assert.equal(await dialog.count(),0);assert.deepEqual(await counts(),[1,1]);
    // Expiry after transcription preserves the segment; login alone never retries.
    await page.getByRole('button',{name:locale==='en'?'Stop':'停止',exact:true}).click();
    await page.waitForFunction(()=>window.discussion.voice.active?.state==='transcribing');
    await page.evaluate(()=>{window.authReady=false;window.finishTranscript();});
    await dialog.waitFor();assert.equal(await page.evaluate(()=>window.discussion.recovery.one.text),'new segment');
    await dialog.getByRole('button',{name:cancel,exact:true}).click();await unchanged();
    await page.locator('.viewer-voice-recovery').getByRole('button',{name:signIn,exact:true}).click();
    await page.waitForFunction(()=>window.loginCalls===2);assert.deepEqual(await counts(),[2,1]);await unchanged();
    await page.getByRole('button',{name:locale==='en'?'Retry rewrite':'重試改寫',exact:true}).click();
    await page.waitForFunction(()=>!window.discussion.voice.active && !window.discussion.recovery.one);
    assert.equal(await field.inputValue(),'Earlier discussion new segment');assert.deepEqual(await counts(),[2,1]);
    await page.evaluate(()=>{window.authReady=false;});
    await add.click();await dialog.waitFor();
    // Programmatic panel closure must dismiss a pending confirmation.
    await page.locator('.player-cue-close').evaluate(e=>e.click());await dialog.waitFor({state:'hidden'});
    assert.deepEqual(await counts(),[2,1]);
    if(bubble){
      if(!await page.locator('.player-choice-cue-trigger').isVisible())await page.getByRole('button',{name:locale==='en'?'Choices':'選項',exact:true}).click();
      await page.locator('.player-choice-cue-trigger').click();
    }else{
      if(!await page.locator('.theater-utilities-section--discussion button').first().isVisible())await page.locator('.theater-utilities-toggle').click();
      await page.locator('.theater-utilities-section--discussion button').first().click();
    }
    await add.click();await dialog.waitFor();
    // Even same-fingerprint project replacement invalidates the old form's owner.
    await page.evaluate(()=>window.discussion.bindProject({...window.discussion.project}));
    await dialog.waitFor({state:'hidden'});assert.deepEqual(await counts(),[2,1]);
    assert.deepEqual(errors,[]);await context.close();
    console.log(`PASS discussion login consent ${locale} ${width}px bubble=${bubble}`);
  }
}finally{await browser.close();}
