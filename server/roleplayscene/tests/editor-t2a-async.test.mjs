import test from 'node:test';
import assert from 'node:assert/strict';

import { renderEditor } from '../scripts/editor/editor.js';
import { createProject, createScene, SceneType } from '../scripts/model.js';
import { createServerApiClient } from '../../app/api/server-api-client.js';

class StubElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.eventListeners = {};
    this.attributes = {};
    this.className = '';
    this.classList = {
      add: (...names) => {
        const existing = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
        names.forEach((name) => existing.add(name));
        this.className = Array.from(existing).join(' ');
      },
    };
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this._innerHTML = '';
    this._textContent = '';
  }

  appendChild(child) {
    child.remove?.();
    child.parentNode = this;
    this.children.push(child);
    if (this.tagName === 'select' && !this.value && child?.tagName === 'option') {
      this.value = child.value || '';
    }
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  replaceChildren(...nodes) {
    this.children.slice().forEach(child => child.remove());
    nodes.forEach(node => this.appendChild(node));
  }

  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    node.remove();
    parent.children[parent.children.indexOf(this)] = node;
    node.parentNode = parent;
    this.parentNode = null;
  }

  append(...nodes) {
    nodes.forEach((node) => {
      if (node instanceof StubElement) {
        this.appendChild(node);
      }
    });
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return [
      this._textContent,
      ...this.children.map((child) => child.textContent || ''),
    ].join('');
  }

  addEventListener(type, handler) {
    this.eventListeners[type] ||= [];
    this.eventListeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    this.eventListeners[type] = (this.eventListeners[type] || []).filter(item => item !== handler);
  }

  dispatchEvent(type, event = {}) {
    const handlers = this.eventListeners[type] || [];
    handlers.forEach((handler) => handler({ ...event, target: event.target ?? this }));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  contains(target) {
    if (!target) return false;
    if (target === this) return true;
    return this.children.some((child) => child.contains?.(target));
  }

  querySelector(selector) {
    if (selector.startsWith('.')) return findElement(this, element => element.className.split(/\s+/).includes(selector.slice(1)));
    const focusMatch = String(selector).match(/^\[data-focus-key="(.+)"\]$/);
    if (!focusMatch) return null;
    return findElement(this, (element) => element.dataset?.focusKey === focusMatch[1]);
  }

  focus() {}
}

class StubDocument extends StubElement {
  constructor() {
    super('#document');
    this.activeElement = null;
  }

  createElement(tagName) {
    return new StubElement(tagName);
  }

  createElementNS(_namespace, tagName) {
    return new StubElement(tagName);
  }
}

class TestStore {
  constructor(project) {
    this.state = { project };
    this.listeners = new Set();
  }

  get() {
    return this.state;
  }

  set(partial) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((listener) => listener(this.state));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

function findElement(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

function findButtonByText(root, text) {
  return findElement(root, (element) => (
    element.tagName === 'button' && element.textContent === text
  ));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for async editor state');
}

function makeProject({ text = 'Hello', audio = null } = {}) {
  return createProject({
    scenes: [
      createScene({
        id: 'scene-1',
        type: SceneType.START,
        dialogue: [{ text, audio }],
      }),
    ],
  });
}

function cloneProjectWithLine(project, updates) {
  return {
    ...project,
    scenes: project.scenes.map((scene, sceneIndex) => (sceneIndex === 0
      ? {
          ...scene,
          dialogue: scene.dialogue.map((line, lineIndex) => (lineIndex === 0
            ? { ...line, ...updates }
            : line)),
        }
      : scene)),
  };
}

function installDomGlobals() {
  globalThis.document = new StubDocument();
  globalThis.URL = {
    createObjectURL: () => `blob:test-${Math.random()}`,
    revokeObjectURL: () => {},
  };
}

test('graph tooltip keyboard handlers are cleaned up on redraw and teardown', () => {
  installDomGlobals();
  const store = new TestStore(makeProject());
  const cleanup = renderEditor(store, document.createElement('div'), document.createElement('div'), () => {});
  assert.equal(document.eventListeners.keydown.length, 1);
  for (let i = 0; i < 5; i++) store.set({ project: { ...store.get().project } });
  assert.equal(document.eventListeners.keydown.length, 1, 'redraws do not accumulate document listeners');
  cleanup();
  assert.equal(document.eventListeners.keydown.length, 0);
});

test('dialogue arrows reorder complete entries and reject boundary moves', () => {
  installDomGlobals();
  const project = makeProject();
  project.scenes[0].dialogue = ['A', 'B', 'C'].map((text, i) => ({ text,
    speakerId: `speaker-${i}`, audio: { name: `${text}.mp3`, objectUrl: `blob:${text}` },
    bubble: { mode: 'anchor', anchorId: `anchor-${i}` },
  }));
  const original = structuredClone(project.scenes[0].dialogue);
  const store = new TestStore(project);
  const right = document.createElement('div');
  renderEditor(store, document.createElement('div'), right, () => {});
  const button = (index, direction) => findElement(right, el => el.dataset?.focusKey === `dialogue-move-scene-1-${index}-${direction}`);
  assert.equal(button(0, -1).disabled, true);
  button(0, -1).dispatchEvent('click');
  assert.deepEqual(store.get().project.scenes[0].dialogue, original);
  button(2, -1).dispatchEvent('click');
  assert.deepEqual(store.get().project.scenes[0].dialogue, [original[0], original[2], original[1]]);
  button(1, 1).dispatchEvent('click');
  assert.deepEqual(store.get().project.scenes[0].dialogue, original);
  assert.equal(button(2, 1).disabled, true);
});

test('pending audio locks scene reordering even through a stale button handler', async () => {
  installDomGlobals();
  const project = makeProject({ text: 'Same text' });
  project.scenes[0].dialogue.push({ ...project.scenes[0].dialogue[0], speakerId: 'other' });
  const store = new TestStore(project);
  const right = document.createElement('div');
  const deferred = createDeferred();
  let calls = 0;
  renderEditor(store, document.createElement('div'), right, () => {}, {
    ensureServerSessionReady: async () => ({ ok: true }),
    apiClient: { generateAudioFromText: () => { calls++; return deferred.promise; } },
  });
  const staleMove = findElement(right, el => el.dataset?.focusKey === 'dialogue-move-scene-1-0-1');
  findButtonByText(right, 'Generate audio').dispatchEvent('click');
  await waitFor(() => calls === 1);
  assert.equal(findElement(right, el => el.dataset?.focusKey === 'dialogue-move-scene-1-0-1').disabled, true);
  staleMove.dispatchEvent('click');
  assert.notEqual(store.get().project.scenes[0].dialogue[0].speakerId, 'other');
  deferred.resolve({ ok: true, data: new Uint8Array([1, 2, 3]) });
  await waitFor(() => findElement(right, el => el.dataset?.focusKey === 'dialogue-move-scene-1-0-1').disabled === false);
  assert.ok(store.get().project.scenes[0].dialogue[0].audio);
  assert.equal(store.get().project.scenes[0].dialogue[0].audio.generatedVoiceChoice, 'cantonese_narrator_female');
  assert.equal(store.get().project.scenes[0].dialogue[1].audio, null);
  findElement(right, el => el.dataset?.focusKey === 'dialogue-move-scene-1-0-1').dispatchEvent('click');
  assert.ok(store.get().project.scenes[0].dialogue[1].audio);
});

test('T2A result is discarded when dialogue text changes before response', async () => {
  installDomGlobals();
  const apiDeferred = createDeferred();
  const messages = [];
  let apiCalls = 0;
  const store = new TestStore(makeProject({ text: 'Hello' }));
  const left = document.createElement('div');
  const right = document.createElement('div');
  const apiClient = {
    generateAudioFromText: () => {
      apiCalls += 1;
      return apiDeferred.promise;
    },
  };

  renderEditor(store, left, right, (message) => messages.push(message), {
    apiClient,
    ensureServerSessionReady: async () => ({ ok: true }),
  });

  findButtonByText(right, 'Generate audio').dispatchEvent('click');
  await waitFor(() => apiCalls === 1);
  store.set({ project: cloneProjectWithLine(store.get().project, { text: 'Changed' }) });
  apiDeferred.resolve({ ok: true, data: new Uint8Array([1, 2, 3]) });
  await waitFor(() => messages.some((message) => message.textId === 'inspector.dialogue.t2aLineChanged'));

  assert.equal(store.get().project.scenes[0].dialogue[0].audio, null);
});

test('T2A result asks before replacing audio added while request is in flight', async () => {
  installDomGlobals();
  const apiDeferred = createDeferred();
  const messages = [];
  let apiCalls = 0;
  let confirmCalls = 0;
  globalThis.confirm = () => {
    confirmCalls += 1;
    return false;
  };
  const manualAudio = {
    name: 'manual.mp3',
    objectUrl: 'blob:manual',
    blob: new Blob([new Uint8Array([9])], { type: 'audio/mpeg' }),
  };
  const store = new TestStore(makeProject({ text: 'Hello' }));
  const left = document.createElement('div');
  const right = document.createElement('div');

  renderEditor(store, left, right, (message) => messages.push(message), {
    apiClient: {
      generateAudioFromText: () => {
        apiCalls += 1;
        return apiDeferred.promise;
      },
    },
    ensureServerSessionReady: async () => ({ ok: true }),
  });

  findButtonByText(right, 'Generate audio').dispatchEvent('click');
  await waitFor(() => apiCalls === 1);
  store.set({ project: cloneProjectWithLine(store.get().project, { audio: manualAudio }) });
  apiDeferred.resolve({ ok: true, data: new Uint8Array([1, 2, 3]) });
  await waitFor(() => messages.some((message) => message.textId === 'inspector.dialogue.t2aCanceled'));

  assert.equal(confirmCalls, 1);
  assert.equal(store.get().project.scenes[0].dialogue[0].audio.name, 'manual.mp3');
});

test('T2A result is ignored after editor teardown', async () => {
  installDomGlobals();
  const apiDeferred = createDeferred();
  const messages = [];
  let apiCalls = 0;
  const store = new TestStore(makeProject({ text: 'Hello' }));
  const left = document.createElement('div');
  const right = document.createElement('div');

  const cleanup = renderEditor(store, left, right, (message) => messages.push(message), {
    apiClient: {
      generateAudioFromText: () => {
        apiCalls += 1;
        return apiDeferred.promise;
      },
    },
    ensureServerSessionReady: async () => ({ ok: true }),
  });

  findButtonByText(right, 'Generate audio').dispatchEvent('click');
  await waitFor(() => apiCalls === 1);
  cleanup();
  apiDeferred.resolve({ ok: true, data: new Uint8Array([1, 2, 3]) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(store.get().project.scenes[0].dialogue[0].audio, null);
  assert.equal(messages.some((message) => message.textId === 'inspector.dialogue.t2aGenerated'), false);
});

test('T2A late auth failure is reported to the server session owner', async () => {
  installDomGlobals();
  const messages = [];
  const serverResults = [];
  const store = new TestStore(makeProject({ text: 'Hello' }));
  const left = document.createElement('div');
  const right = document.createElement('div');
  const authFailure = {
    ok: false,
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Session expired.',
      status: 401,
      requiresSignIn: true,
    },
  };

  renderEditor(store, left, right, (message) => messages.push(message), {
    apiClient: {
      generateAudioFromText: async () => authFailure,
    },
    ensureServerSessionReady: async () => ({ ok: true }),
    onServerApiResult: (result) => serverResults.push(result),
  });

  findButtonByText(right, 'Generate audio').dispatchEvent('click');
  await waitFor(() => serverResults.length === 1);

  assert.equal(serverResults[0], authFailure);
  assert.equal(store.get().project.scenes[0].dialogue[0].audio, null);
  assert.equal(
    messages.some((message) => (
      message.textId === 'inspector.dialogue.t2aSessionExpired'
    )),
    true,
  );
});

test('voice selections remember speakers without changing other explicit lines and survive redraw/reordering', () => {
  installDomGlobals();
  const p = makeProject();
  p.speakers = [{id:'a',name:'Alex'}, {id:'b',name:'B'}];
  p.scenes[0].dialogue = [{text:'One',speakerId:'a'}, {text:'Two',speakerId:'a',voiceChoice:'cantonese_female_1'}, {text:'Three',speakerId:'a'}];
  const store = new TestStore(p), right = document.createElement('div');
  renderEditor(store, document.createElement('div'), right, () => {});
  const select = i => findElement(right, el => el.dataset?.focusKey === `dialogue-t2a-preset-scene-1-${i}`);
  select(0).value = 'cantonese_male_3'; select(0).dispatchEvent('change');
  assert.equal(store.get().project.speakers[0].lastVoiceChoice, 'cantonese_male_3');
  assert.equal(select(0).value, 'cantonese_male_3');
  assert.equal(select(1).value, 'cantonese_female_1');
  assert.equal(select(2).value, 'cantonese_male_3');
  select(2).value = 'cantonese_female_3'; select(2).dispatchEvent('change');
  store.set({project:{...store.get().project, speakers:store.get().project.speakers.map(s=>({...s,name:'Renamed'}))}});
  assert.equal(select(0).value, 'cantonese_male_3');
  assert.equal(select(2).value, 'cantonese_female_3');
  findElement(right, el=>el.dataset?.focusKey==='dialogue-move-scene-1-2--1').dispatchEvent('click');
  assert.equal(select(1).value, 'cantonese_female_3');
  assert.equal(store.get().project.speakers[0].lastVoiceChoice, 'cantonese_female_3');
  const speaker = findElement(right, el=>el.dataset?.focusKey==='dialogue-speaker-scene-1-1');
  speaker.value='b'; speaker.dispatchEvent('change');
  assert.equal(select(1).value,'cantonese_female_3');
  assert.equal(store.get().project.speakers[1].lastVoiceChoice,undefined);
});

test('late generation cannot attach to another identical line or replacement project', async () => {
  for (const replacement of ['delete','project']) {
    installDomGlobals();
    const p=makeProject({text:'Same'});p.scenes[0].dialogue.push({...p.scenes[0].dialogue[0]});
    const store=new TestStore(p), right=document.createElement('div'), deferred=createDeferred();let calls=0;
    renderEditor(store,document.createElement('div'),right,()=>{}, {ensureServerSessionReady:async()=>({ok:true}),apiClient:{generateAudioFromText:()=>{calls++;return deferred.promise;}}});
    findButtonByText(right,'Generate audio').dispatchEvent('click');await waitFor(()=>calls===1);
    if(replacement==='delete') findElement(right,el=>el.dataset?.focusKey==='dialogue-remove-scene-1-0').dispatchEvent('click');
    else store.set({project:makeProject({text:'Same'})});
    await waitFor(()=>findButtonByText(right,'Generate audio')?.disabled===false);
    deferred.resolve({ok:true,data:new Uint8Array([1,2,3])});
    await waitFor(()=>findButtonByText(right,'Generate audio')?.disabled===false);
    assert.equal(store.get().project.scenes[0].dialogue[0].audio,null);
  }
});

test('removing confirmed audio while generation is pending must not restore it', async () => {
  installDomGlobals();globalThis.confirm=()=>true;
  const store=new TestStore(makeProject({audio:{name:'old.mp3',objectUrl:'blob:old'}}));
  const right=document.createElement('div'), request=createDeferred();let calls=0;
  renderEditor(store,document.createElement('div'),right,()=>{}, {ensureServerSessionReady:async()=>({ok:true}),apiClient:{generateAudioFromText:()=>{calls++;return request.promise;}}});
  findButtonByText(right,'Regenerate audio').dispatchEvent('click');await waitFor(()=>calls===1);
  store.set({project:cloneProjectWithLine(store.get().project,{audio:null})});
  request.resolve({ok:true,data:new Uint8Array([1,2,3])});
  await waitFor(()=>!findButtonByText(right,'Generating audio...'));
  assert.equal(store.get().project.scenes[0].dialogue[0].audio,null);
});

test('failed replacement URL creation must keep the original playback URL usable', async () => {
  installDomGlobals();globalThis.confirm=()=>true;
  const revoked=[];globalThis.URL.revokeObjectURL=url=>revoked.push(url);
  globalThis.URL.createObjectURL=()=>{throw new Error('Allocation failed');};
  const store=new TestStore(makeProject({audio:{name:'old.mp3',objectUrl:'blob:old'}})), right=document.createElement('div');
  const messages=[];
  renderEditor(store,document.createElement('div'),right,m=>messages.push(m), {ensureServerSessionReady:async()=>({ok:true}),apiClient:{generateAudioFromText:async()=>({ok:true,data:new Uint8Array([1,2,3])})}});
  findButtonByText(right,'Regenerate audio').dispatchEvent('click');await waitFor(()=>messages.some(m=>m.textId==='inspector.dialogue.t2aFailedWithDetail'));
  assert.equal(store.get().project.scenes[0].dialogue[0].audio.objectUrl,'blob:old');
  assert.deepEqual(revoked,[]);
});

test('real client handles expiry, HTML login, rejection, offline and interrupted bodies without losing old audio', async t => {
  const scenarios = [
    ['401',()=>new Response('',{status:401}),true],
    ['403',()=>new Response('',{status:403}),true],
    ['login',()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}}),true],
    ['unsupported',()=>new Response(JSON.stringify({error:{code:'VOICE_CHOICE_UNSUPPORTED',message:'Unsupported'}}),{status:422,headers:{'content-type':'application/json'}}),false],
    ['server',()=>new Response('Unavailable',{status:503}),false],
    ['offline',()=>{throw new TypeError('Failed to fetch');},false],
    ['empty',()=>new Response(new Uint8Array(),{headers:{'content-type':'audio/mpeg'}}),false],
    ['read failure',()=>({ok:true,status:200,headers:new Headers({'content-type':'audio/mpeg'}),arrayBuffer:async()=>{throw new Error('Connection reset');}}),false],
  ];
  for (const [name, response, auth] of scenarios) {
    installDomGlobals();globalThis.confirm=()=>true;
    let retry=false,calls=0;
    t.mock.method(globalThis,'fetch',async()=>{calls++;return retry?new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}}):response();});
    const store=new TestStore(makeProject({audio:{name:'old.mp3',objectUrl:'blob:old'}})),right=document.createElement('div'),messages=[];
    const cleanup=renderEditor(store,document.createElement('div'),right,m=>messages.push(m),{ensureServerSessionReady:async()=>({ok:true}),apiClient:createServerApiClient()});
    findButtonByText(right,'Regenerate audio').dispatchEvent('click');
    await waitFor(()=>messages.length>0 && !findButtonByText(right,'Generating audio...'));
    assert.equal(calls,1,name+' must not retry automatically');
    assert.equal(store.get().project.scenes[0].dialogue[0].audio.objectUrl,'blob:old',name);
    assert.equal(Boolean(findButtonByText(right,'Sign in')),auth,name);
    retry=true;findButtonByText(right,'Regenerate audio').dispatchEvent('click');
    await waitFor(()=>store.get().project.scenes[0].dialogue[0].audio.generatedVoiceChoice==='cantonese_narrator_female');
    assert.equal(calls,2,name+' manual retry');
    cleanup();t.mock.restoreAll();
  }
});

test('timeouts release generation locks and ignore late results; editor disposal aborts fetch', async () => {
  for(const stage of ['session','generation','dispose']) {
    installDomGlobals();const deferred=createDeferred();let signal;
    const store=new TestStore(makeProject()),right=document.createElement('div'),messages=[];
    const cleanup=renderEditor(store,document.createElement('div'),right,m=>messages.push(m),{
      audioRequestTimeoutMs:stage==='dispose'?1000:5,
      ensureServerSessionReady:()=>stage==='session'?deferred.promise:Promise.resolve({ok:true}),
      apiClient:{generateAudioFromText:(_text,_options,request)=>{signal=request.signal;return deferred.promise;}}
    });
    findButtonByText(right,'Generate audio').dispatchEvent('click');
    if(stage==='dispose') {await waitFor(()=>signal);cleanup();await waitFor(()=>signal.aborted);}
    else {await waitFor(()=>messages.some(m=>m.textId==='inspector.dialogue.t2aTimedOut'));assert.equal(findButtonByText(right,'Generate audio').disabled,false);}
    const count=messages.length;
    deferred.resolve(stage==='session'?{ok:true}:{ok:true,data:new Uint8Array([1,2,3])});
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(store.get().project.scenes[0].dialogue[0].audio,null);
    assert.equal(messages.length,count);
    cleanup();
  }
});
