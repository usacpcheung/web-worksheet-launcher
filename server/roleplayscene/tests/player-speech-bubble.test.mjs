import assert from 'node:assert/strict';

class StubClassList {
  constructor(element) {
    this.element = element;
  }

  _set(classes) {
    this.element.className = Array.from(classes).join(' ');
  }

  _get() {
    return new Set(String(this.element.className || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    const classes = this._get();
    names.forEach(name => classes.add(name));
    this._set(classes);
  }

  remove(...names) {
    const classes = this._get();
    names.forEach(name => classes.delete(name));
    this._set(classes);
  }

  toggle(name, force) {
    const classes = this._get();
    const shouldAdd = force ?? !classes.has(name);
    if (shouldAdd) {
      classes.add(name);
    } else {
      classes.delete(name);
    }
    this._set(classes);
    return shouldAdd;
  }

  contains(name) {
    return this._get().has(name);
  }
}

class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.eventListeners = {};
    this.attributes = {};
    this.style = {};
    this._innerHTML = '';
    this.textContent = '';
    this.className = '';
    this.type = '';
    this.disabled = false;
    this.classList = new StubClassList(this);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, handler) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this.eventListeners[type]) return;
    this.eventListeners[type] = this.eventListeners[type].filter(cb => cb !== handler);
  }

  dispatchEvent(type, event = {}) {
    for (const handler of this.eventListeners[type] || []) {
      handler(event);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
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
    this.currentTime = 0;
    this.paused = true;
    this.volume = 1;
    this._listeners = {};
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

  addEventListener(type, handler) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(cb => cb !== handler);
  }

  trigger(type, event = {}) {
    for (const handler of this._listeners[type] || []) {
      handler(event);
    }
  }
}

FakeAudio.instances = [];
FakeAudio.playCalls = [];
FakeAudio.pauseCalls = [];

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const pendingTimeouts = [];
const timeoutRegistry = new Map();
let nextTimeoutId = 1;

globalThis.setTimeout = (callback, delay = 0, ...args) => {
  const id = nextTimeoutId++;
  const timer = { id, callback, delay, args, cleared: false };
  timeoutRegistry.set(id, timer);
  pendingTimeouts.push(timer);
  return id;
};

globalThis.clearTimeout = (id) => {
  const timer = timeoutRegistry.get(id);
  if (!timer) return;
  timer.cleared = true;
  timeoutRegistry.delete(id);
  const index = pendingTimeouts.indexOf(timer);
  if (index !== -1) pendingTimeouts.splice(index, 1);
};

globalThis.document = new StubDocument();
globalThis.Audio = FakeAudio;

const { renderPlayerUI, splitSpeechBubbleText } = await import('../scripts/player/ui.js');
const { BubbleMode, SceneType } = await import('../scripts/model.js');
const { translate, setActiveLocale } = await import('../scripts/i18n.js');

setActiveLocale('en');

function resetSpies() {
  FakeAudio.instances.length = 0;
  FakeAudio.playCalls.length = 0;
  FakeAudio.pauseCalls.length = 0;
  pendingTimeouts.length = 0;
  timeoutRegistry.clear();
}

function createRoot() {
  return new StubElement('div');
}

function hasClass(element, className) {
  return String(element.className || '').split(/\s+/).includes(className);
}

function findByClass(root, className) {
  if (hasClass(root, className)) return root;
  for (const child of root.children || []) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

function findAllByClass(root, className, results = []) {
  if (hasClass(root, className)) results.push(root);
  for (const child of root.children || []) {
    findAllByClass(child, className, results);
  }
  return results;
}

function findButtonByText(root, text) {
  if (root.tagName === 'BUTTON' && collectText(root) === text) return root;
  for (const child of root.children || []) {
    const match = findButtonByText(child, text);
    if (match) return match;
  }
  return null;
}

function collectText(root) {
  const own = root.textContent || '';
  return `${own}${(root.children || []).map(collectText).join('')}`;
}

function render(scene, onChoice = () => {}) {
  const stageEl = createRoot();
  const uiEl = createRoot();
  const project = {
    scenes: [
      scene,
      { id: 'next-scene', type: SceneType.END, dialogue: [{ text: 'The end' }], choices: [] },
    ],
  };
  const cleanup = renderPlayerUI({ stageEl, uiEl, project, scene, onChoice });
  return { stageEl, uiEl, cleanup };
}

try {
  resetSpies();
  let scene = {
    id: 'scene-bubble',
    type: SceneType.INTERMEDIATE,
    image: { objectUrl: 'image.png' },
    speechBubble: {
      enabled: true,
      anchors: [{ id: 'anchor-a', label: 'A', x: 0.95, y: 0.05 }],
    },
    dialogue: [
      {
        text: 'Hello from the anchor.',
        audio: { objectUrl: 'line-1.mp3' },
        bubble: { mode: BubbleMode.ANCHOR, anchorId: 'anchor-a' },
      },
      {
        text: 'Hidden line should not appear.',
        bubble: { mode: BubbleMode.HIDDEN },
      },
      {
        text: 'Narration in the center.',
        bubble: { mode: BubbleMode.CENTER },
      },
    ],
    choices: [],
  };

  let { stageEl, uiEl } = render(scene);
  assert.ok(findByClass(stageEl, 'speech-play-overlay'), 'Bubble-enabled scenes should render an image overlay');
  assert.ok(findByClass(uiEl, 'speech-play-panel'), 'Bubble-enabled scenes should render the speech controller');
  assert.equal(findByClass(uiEl, 'player-dialogue'), null, 'Bubble-enabled scenes should not render the normal dialogue list');

  findButtonByText(uiEl, translate('player.speechBubble.startDialogue')).dispatchEvent('click');
  assert.equal(FakeAudio.playCalls[0], 'line-1.mp3', 'Start dialogue should autoplay the first line when audio exists');

  let bubble = findByClass(stageEl, 'speech-play-bubble--anchor');
  assert.ok(bubble, 'Anchor dialogue should render an anchor bubble');
  assert.equal(bubble.style.left, '88%', 'Anchor bubble should clamp near the right edge');
  assert.equal(bubble.style.top, '12%', 'Anchor bubble should clamp near the top edge');
  assert.match(collectText(bubble), /Hello from the anchor/);

  findButtonByText(uiEl, translate('player.speechBubble.next')).dispatchEvent('click');
  bubble = findByClass(stageEl, 'speech-play-bubble--center');
  assert.ok(bubble, 'Next should skip hidden lines and render center narration');
  assert.match(collectText(bubble), /Narration in the center/);
  assert.equal(FakeAudio.playCalls.length, 1, 'No-audio narration should not start extra audio');

  resetSpies();
  scene = {
    id: 'scene-normal',
    type: SceneType.INTERMEDIATE,
    dialogue: [{ text: 'Normal dialogue remains visible.' }],
    choices: [],
  };
  ({ uiEl } = render(scene));
  assert.ok(findByClass(uiEl, 'player-dialogue'), 'Non-bubble scenes should keep the existing dialogue list');

  const pages = splitSpeechBubbleText(
    'This is a longer line. It should split into multiple readable speech bubble pages for the player controls.',
    BubbleMode.ANCHOR,
  );
  assert.ok(pages.length > 1, 'Long speech bubble text should split into multiple pages');

  resetSpies();
  const longNarration = [
    'This is a longer line.',
    'It should split into multiple readable speech bubble pages for the player controls.',
    'The second half gives the reader enough text to require another page in center narration mode.',
    'Manual controls should let the user move forward without changing the package data.',
  ].join(' ');

  scene = {
    id: 'scene-pages',
    type: SceneType.INTERMEDIATE,
    speechBubble: { enabled: true, anchors: [] },
    dialogue: [{
      text: longNarration,
      bubble: { mode: BubbleMode.CENTER },
    }],
    choices: [],
  };
  ({ stageEl, uiEl } = render(scene));
  findButtonByText(uiEl, translate('player.speechBubble.startDialogue')).dispatchEvent('click');
  assert.ok(findByClass(uiEl, 'speech-play-page-controls'), 'Paged speech bubbles should show page controls');
  const firstPageText = collectText(findByClass(stageEl, 'speech-play-bubble'));
  findButtonByText(uiEl, translate('player.speechBubble.nextPage')).dispatchEvent('click');
  assert.notEqual(collectText(findByClass(stageEl, 'speech-play-bubble')), firstPageText, 'Manual page next should change the visible page');

  resetSpies();
  let chosenSceneId = null;
  scene = {
    id: 'scene-choice',
    type: SceneType.INTERMEDIATE,
    speechBubble: { enabled: true, anchors: [] },
    dialogue: [{ text: 'Choose a path.', bubble: { mode: BubbleMode.CENTER } }],
    choices: [{ label: 'Go next', nextSceneId: 'next-scene' }],
  };
  ({ uiEl } = render(scene, (nextSceneId) => { chosenSceneId = nextSceneId; }));
  findButtonByText(uiEl, 'Go next').dispatchEvent('click');
  assert.equal(chosenSceneId, 'next-scene', 'Bubble mode should keep scene choices available');

  console.log('player speech bubble tests passed');
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
