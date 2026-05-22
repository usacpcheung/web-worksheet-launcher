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

  get offsetWidth() {
    if (hasClass(this, 'speech-play-overlay')) return 1000;
    if (hasClass(this, 'speech-play-bubble-wrap')) return 340;
    return 0;
  }

  get offsetHeight() {
    if (hasClass(this, 'speech-play-overlay')) return 600;
    if (hasClass(this, 'speech-play-bubble-wrap')) return 120;
    return 0;
  }
}

class StubDocument {
  constructor() {
    this.eventListeners = {};
  }

  createElement(tagName) {
    return new StubElement(tagName);
  }

  createElementNS(_namespace, tagName) {
    return new StubElement(tagName);
  }

  addEventListener(type, handler) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this.eventListeners[type]) return;
    this.eventListeners[type] = this.eventListeners[type].filter(cb => cb !== handler);
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

function flushPendingTimeouts() {
  const timers = pendingTimeouts.splice(0, pendingTimeouts.length);
  for (const timer of timers) {
    if (timer.cleared) continue;
    timeoutRegistry.delete(timer.id);
    timer.callback(...timer.args);
  }
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

function render(scene, onChoice = () => {}, projectOverrides = {}) {
  const stageEl = createRoot();
  const uiEl = createRoot();
  const project = {
    ...projectOverrides,
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
        speakerId: 'speaker-kelvin',
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

  let { stageEl, uiEl } = render(scene, () => {}, { speakers: [{ id: 'speaker-kelvin', name: 'Kelvin' }] });
  assert.ok(findByClass(stageEl, 'speech-play-overlay'), 'Bubble-enabled scenes should render an image overlay');
  assert.ok(findByClass(stageEl, 'speech-play-panel'), 'Bubble-enabled scenes should render the speech controller');
  assert.equal(findByClass(uiEl, 'player-dialogue'), null, 'Bubble-enabled scenes should not render the normal dialogue list');

  findButtonByText(stageEl, translate('player.speechBubble.play')).dispatchEvent('click');
  assert.equal(FakeAudio.playCalls[0], 'line-1.mp3', 'Start dialogue should autoplay the first line when audio exists');

  let bubble = findByClass(stageEl, 'speech-play-bubble-wrap--anchor');
  assert.ok(bubble, 'Anchor dialogue should render an anchor bubble');
  assert.ok(findByClass(bubble, 'speech-play-bubble-shape')?.getAttribute('d'), 'Anchor bubble should draw an SVG comic tail shape');
  assert.ok(bubble.classList.contains('speech-play-bubble-wrap--positioned'), 'Anchor bubble should be measured before it is shown');
  assert.match(bubble.style.left, /px$/, 'Anchor bubble should be positioned in stage pixels');
  assert.match(bubble.style.top, /px$/, 'Anchor bubble should be positioned in stage pixels');
  assert.match(collectText(bubble), /Hello from the anchor/);
  assert.match(collectText(bubble), /Kelvin:/, 'Speech bubble should render assigned speaker name');

  findButtonByText(stageEl, translate('player.speechBubble.next')).dispatchEvent('click');
  bubble = findByClass(stageEl, 'speech-play-bubble--center');
  assert.ok(bubble, 'Next should skip hidden lines and render center narration');
  assert.match(collectText(bubble), /Narration in the center/);
  assert.equal(FakeAudio.playCalls.length, 1, 'No-audio narration should not start extra audio');

  resetSpies();
  scene = {
    id: 'scene-normal',
    type: SceneType.INTERMEDIATE,
    dialogue: [{ text: 'Normal dialogue remains visible.', speakerId: 'speaker-sam' }],
    choices: [],
  };
  ({ stageEl, uiEl } = render(scene, () => {}, { speakers: [{ id: 'speaker-sam', name: 'Sam' }] }));
  assert.ok(findByClass(stageEl, 'theater-dialogue-card'), 'Non-bubble scenes should render the theater dialogue overlay');
  assert.equal(findByClass(uiEl, 'player-dialogue'), null, 'Non-bubble scenes should no longer render the old dialogue list');
  assert.match(collectText(stageEl), /Sam:/, 'Normal dialogue should render assigned speaker name');

  resetSpies();
  scene = {
    id: 'scene-center-audio',
    type: SceneType.INTERMEDIATE,
    speechBubble: { enabled: true, anchors: [] },
    dialogue: [
      { text: 'Center narration with audio.', audio: { objectUrl: 'center-line.mp3' }, bubble: { mode: BubbleMode.CENTER } },
    ],
    choices: [],
  };
  ({ stageEl, uiEl } = render(scene));
  findButtonByText(stageEl, translate('player.speechBubble.play')).dispatchEvent('click');
  const centerBubble = findByClass(stageEl, 'speech-play-bubble--center');
  findButtonByText(stageEl, translate('player.speechBubble.stop')).dispatchEvent('click');
  assert.equal(
    findByClass(stageEl, 'speech-play-bubble--center'),
    centerBubble,
    'Stopping center narration playback should not recreate the visible bubble',
  );
  findButtonByText(stageEl, translate('player.speechBubble.play')).dispatchEvent('click');
  assert.equal(
    findByClass(stageEl, 'speech-play-bubble--center'),
    centerBubble,
    'Restarting center narration playback should not recreate the visible bubble',
  );

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
  assert.ok(findByClass(stageEl, 'speech-play-page-controls'), 'Paged speech bubbles should show page controls');
  const firstPageText = collectText(findByClass(stageEl, 'speech-play-bubble'));
  findButtonByText(stageEl, translate('player.speechBubble.nextPage')).dispatchEvent('click');
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
  ({ stageEl, uiEl } = render(scene, (nextSceneId) => { chosenSceneId = nextSceneId; }));
  findButtonByText(stageEl, 'Go next').dispatchEvent('click');
  assert.equal(chosenSceneId, 'next-scene', 'Bubble mode should keep scene choices available');

  resetSpies();
  scene = {
    id: 'scene-play-all-audio',
    type: SceneType.INTERMEDIATE,
    speechBubble: { enabled: true, anchors: [] },
    dialogue: [
      { text: 'Short.', audio: { objectUrl: 'slow-line.mp3' }, bubble: { mode: BubbleMode.CENTER } },
      { text: 'Next line.', audio: { objectUrl: 'next-line.mp3' }, bubble: { mode: BubbleMode.CENTER } },
    ],
    choices: [],
  };
  ({ stageEl, uiEl } = render(scene));
  findButtonByText(stageEl, translate('player.speechBubble.playAll')).dispatchEvent('click');
  assert.equal(FakeAudio.playCalls[0], 'slow-line.mp3', 'Play All should start first audio line');
  flushPendingTimeouts();
  assert.equal(
    FakeAudio.playCalls.length,
    1,
    'Play All should not advance to the next line until the real audio ended event fires',
  );
  FakeAudio.instances[0].trigger('ended');
  assert.equal(
    FakeAudio.playCalls[1],
    'next-line.mp3',
    'Play All should advance after both page presentation and actual audio completion',
  );

  resetSpies();
  ({ stageEl, uiEl } = render(scene));
  findButtonByText(stageEl, translate('player.speechBubble.playAll')).dispatchEvent('click');
  const originalConsoleWarn = console.warn;
  console.warn = () => {};
  try {
    FakeAudio.instances[0].trigger('error', new Error('broken audio'));
  } finally {
    console.warn = originalConsoleWarn;
  }
  flushPendingTimeouts();
  assert.equal(FakeAudio.playCalls.length, 1, 'Audio errors should cancel Play All timers instead of advancing later');

  resetSpies();
  const listenerDocument = globalThis.document;
  const beforeCleanupListeners = (listenerDocument.eventListeners.keydown || []).length;
  const rendered = render(scene);
  assert.ok(
    (listenerDocument.eventListeners.keydown || []).length > beforeCleanupListeners,
    'Bubble render should register cue-card document listeners',
  );
  rendered.cleanup();
  assert.equal(
    (listenerDocument.eventListeners.keydown || []).length,
    beforeCleanupListeners,
    'Bubble cleanup should remove cue-card document listeners',
  );

  console.log('player speech bubble tests passed');
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
