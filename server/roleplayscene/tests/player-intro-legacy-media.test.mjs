class StubElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.eventListeners = {};
    this.attributes = {};
    this._innerHTML = '';
    this._textContent = '';
    this.className = '';
    this.dataset = {};
    this.disabled = false;
    this.value = '';
    this.type = '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    nodes.forEach(node => {
      if (node instanceof StubElement) {
        this.appendChild(node);
      }
    });
  }

  set innerHTML(value) {
    this._innerHTML = value;
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
    if (this.children.length) {
      return this.children.map(child => child.textContent || '').join('');
    }
    return this._textContent;
  }

  addEventListener(type, handler) {
    if (!this.eventListeners[type]) {
      this.eventListeners[type] = [];
    }
    this.eventListeners[type].push(handler);
  }

  dispatchEvent(type, event = {}) {
    const handlers = this.eventListeners[type] || [];
    handlers.forEach(handler => handler({ ...event, target: event.target ?? this }));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

class StubDocument {
  createElement(tagName) {
    return new StubElement(tagName);
  }
}

class FakeAudio {
  constructor(src) {
    this.src = src;
    this.loop = false;
    this.paused = true;
    this.currentTime = 0;
    this.volume = 1;
    FakeAudio.instances.push(this);
  }

  play() {
    this.paused = false;
    FakeAudio.playCalls.push(this.src);
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    FakeAudio.pauseCalls.push(this.src);
  }

  addEventListener() {}
  removeEventListener() {}
}

FakeAudio.instances = [];
FakeAudio.playCalls = [];
FakeAudio.pauseCalls = [];

function resetAudioSpies() {
  FakeAudio.instances.length = 0;
  FakeAudio.playCalls.length = 0;
  FakeAudio.pauseCalls.length = 0;
}

function logResult(label, condition) {
  const status = condition ? 'OK' : 'FAIL';
  console.log(`${status}: ${label}`);
}

function findElement(root, predicate) {
  if (!root) {
    return null;
  }
  if (predicate(root)) {
    return root;
  }
  for (const child of root.children || []) {
    const match = findElement(child, predicate);
    if (match) {
      return match;
    }
  }
  return null;
}

globalThis.document = new StubDocument();
globalThis.Audio = FakeAudio;

const { renderPlayer } = await import('../scripts/player/player.js');
const { Store } = await import('../scripts/state.js');
const { SceneType } = await import('../scripts/model.js');

function makeStoreWithProject(scenePatch) {
  const store = new Store();
  store.set({
    audioGate: true,
    project: {
      meta: { title: 'Legacy Intro Media' },
      scenes: [
        {
          id: 'start-legacy',
          type: SceneType.START,
          image: null,
          backgroundAudio: null,
          dialogue: [{ text: 'Welcome', audio: null }],
          choices: [],
          autoNextSceneId: null,
          notes: '',
          ...scenePatch,
        },
      ],
    },
  });
  return store;
}

function runIntroCase(label, scenePatch) {
  resetAudioSpies();
  const store = makeStoreWithProject(scenePatch);
  const stageHost = new StubElement('div');
  const uiHost = new StubElement('div');
  const cleanup = renderPlayer(store, stageHost, uiHost, () => {});

  const emptyStage = findElement(stageHost, el => el.className === 'stage-empty');
  const imageEl = findElement(stageHost, el => el.tagName === 'img');
  const volumeSlider = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');

  logResult(`${label}: falls back to empty intro stage`, Boolean(emptyStage) && !imageEl);
  logResult(`${label}: does not autoplay intro background when objectUrl is missing`, FakeAudio.playCalls.length === 0);
  logResult(`${label}: does not render intro background controls without playable source`, !volumeSlider);

  cleanup();
}

runIntroCase('Legacy JSON image name only', {
  image: { name: 'start.png' },
  backgroundAudio: null,
});

runIntroCase('Legacy ZIP missing media objectUrl', {
  image: { name: 'start.png', objectUrl: null },
  backgroundAudio: { name: 'bg.mp3' },
});

runIntroCase('No Start media at all', {
  image: null,
  backgroundAudio: null,
});

resetAudioSpies();

{
  const store = makeStoreWithProject({
    image: { name: 'start.png', objectUrl: 'start-image.png' },
    backgroundAudio: null,
  });
  const stageHost = new StubElement('div');
  const uiHost = new StubElement('div');
  const cleanup = renderPlayer(store, stageHost, uiHost, () => {});

  const introImage = findElement(stageHost, el => el.tagName === 'img');
  const emptyStage = findElement(stageHost, el => el.className === 'stage-empty');

  logResult('Start image renders on intro stage when objectUrl exists', Boolean(introImage) && introImage.src === 'start-image.png');
  logResult('Intro stage-empty placeholder hidden when image exists', !emptyStage);

  cleanup();
}

resetAudioSpies();

{
  const store = makeStoreWithProject({
    image: null,
    backgroundAudio: null,
  });
  const stageHost = new StubElement('div');
  const uiHost = new StubElement('div');
  const cleanup = renderPlayer(store, stageHost, uiHost, () => {});

  const emptyStage = findElement(stageHost, el => el.className === 'stage-empty');
  logResult('Intro stage-empty placeholder shown when image missing', Boolean(emptyStage) && emptyStage.textContent === 'Ready to play');

  cleanup();
}
