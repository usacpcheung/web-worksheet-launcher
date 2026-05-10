class StubElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.eventListeners = {};
    this.attributes = {};
    this._innerHTML = '';
    this.textContent = '';
    this.className = '';
    this.type = '';
    this.disabled = false;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, handler) {
    if (!this.eventListeners[type]) {
      this.eventListeners[type] = [];
    }
    this.eventListeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this.eventListeners[type]) {
      return;
    }
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
    if (!this._listeners[type]) {
      this._listeners[type] = [];
    }
    this._listeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this._listeners[type]) {
      return;
    }
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

class FakeAudioNode {
  constructor() {
    this.connections = [];
  }

  connect(node) {
    this.connections.push(node);
    return node;
  }

  disconnect() {
    // noop for tests
  }
}

class FakeMediaElementSource extends FakeAudioNode {
  constructor(element) {
    super();
    this.element = element;
  }
}

class FakeGainNode extends FakeAudioNode {
  constructor() {
    super();
    this.gain = { value: 1 };
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.destination = new FakeAudioNode();
    this.sources = [];
    this.gainNodes = [];
    FakeAudioContext.instances.push(this);
  }

  createMediaElementSource(element) {
    const source = new FakeMediaElementSource(element);
    this.sources.push(source);
    return source;
  }

  createGain() {
    const gain = new FakeGainNode();
    this.gainNodes.push(gain);
    return gain;
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

FakeAudioContext.instances = [];

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

let nextTimeoutId = 1;
const pendingTimeouts = [];
const timeoutRegistry = new Map();

globalThis.setTimeout = (callback, delay = 0, ...args) => {
  const id = nextTimeoutId++;
  const timer = { id, callback, delay, args, cleared: false };
  timeoutRegistry.set(id, timer);
  pendingTimeouts.push(timer);
  return id;
};

globalThis.clearTimeout = (id) => {
  if (!timeoutRegistry.has(id)) {
    return;
  }

  const timer = timeoutRegistry.get(id);
  timer.cleared = true;
  timeoutRegistry.delete(id);
  const index = pendingTimeouts.indexOf(timer);
  if (index !== -1) {
    pendingTimeouts.splice(index, 1);
  }
};

function flushPendingTimeouts() {
  const timers = pendingTimeouts.splice(0, pendingTimeouts.length);
  for (const timer of timers) {
    if (timer.cleared) {
      continue;
    }
    timeoutRegistry.delete(timer.id);
    timer.callback(...timer.args);
  }
}

function resetAudioSpies() {
  FakeAudio.instances.length = 0;
  FakeAudio.playCalls.length = 0;
  FakeAudio.pauseCalls.length = 0;
  FakeAudioContext.instances.length = 0;
}

globalThis.document = new StubDocument();
globalThis.Audio = FakeAudio;
globalThis.AudioContext = FakeAudioContext;

const { renderPlayerUI } = await import('../scripts/player/ui.js');
const { SceneType } = await import('../scripts/model.js');
const { translate, setActiveLocale } = await import('../scripts/i18n.js');

setActiveLocale('en');

function createStage() {
  return new StubElement('div');
}

function createUIRoot() {
  return new StubElement('div');
}

function findByClass(root, className) {
  const classes = (root.className || '').split(/\s+/).filter(Boolean);
  if (classes.includes(className)) {
    return root;
  }
  for (const child of root.children || []) {
    const match = findByClass(child, className);
    if (match) {
      return match;
    }
  }
  return null;
}

function logResult(label, condition) {
  const status = condition ? 'OK' : 'FAIL';
  console.log(`${status}: ${label}`);
}

function renderScene(scene) {
  const stageEl = createStage();
  const uiEl = createUIRoot();
  const project = { scenes: [scene] };
  renderPlayerUI({ stageEl, uiEl, project, scene, onChoice: () => {} });
  return { stageEl, uiEl };
}

// Test: button hidden when no audio dialogue
resetAudioSpies();
let scene = {
  id: 'scene-1',
  type: SceneType.INTERMEDIATE,
  dialogue: [{ text: 'Hello there' }],
  choices: [],
};

let { uiEl } = renderScene(scene);
let playAllButton = findByClass(uiEl, 'audio-play-all');
logResult('Play All button hidden when no audio', playAllButton === null);

// Test: sequential playback across multiple clips
resetAudioSpies();
scene = {
  id: 'scene-2',
  type: SceneType.INTERMEDIATE,
  dialogue: [
    { text: 'Line 1', audio: { objectUrl: 'audio-1.ogg' } },
    { text: 'Line 2', audio: { objectUrl: 'audio-2.ogg' } },
  ],
  choices: [],
};

({ uiEl } = renderScene(scene));
playAllButton = findByClass(uiEl, 'audio-play-all');
logResult('Play All button renders when audio present', !!playAllButton);

playAllButton.dispatchEvent('click');
logResult('First clip starts playback', FakeAudio.playCalls[0] === 'audio-1.ogg');

const contextInstance = FakeAudioContext.instances[0] ?? null;
const boostValue = contextInstance?.gainNodes?.[0]?.gain?.value ?? 0;
logResult('Dialogue gain boosted to 130%', Math.abs(boostValue - 1.3) < 0.001);
logResult('Dialogue audio context created once', FakeAudioContext.instances.length === 1);
logResult(
  'Dialogue gain connected to destination',
  Boolean(contextInstance?.gainNodes?.[0]?.connections?.includes(contextInstance?.destination)),
);
logResult(
  'Dialogue source routed through gain node',
  Boolean(contextInstance?.sources?.[0]?.connections?.includes(contextInstance?.gainNodes?.[0])),
);

FakeAudio.instances[0].trigger('ended');
logResult('Next clip waits for 500ms gap', FakeAudio.playCalls.length === 1);
logResult('Sequence schedules 500ms delay', pendingTimeouts[0]?.delay === 500);
flushPendingTimeouts();
logResult('Second clip starts after scheduled delay', FakeAudio.playCalls[1] === 'audio-2.ogg');

FakeAudio.instances[0].trigger('ended');
flushPendingTimeouts();
logResult('Button resets after final clip', playAllButton.textContent === translate('player.dialogue.playAll'));

// Test: repeat click stops and restart works
resetAudioSpies();
({ uiEl } = renderScene(scene));
playAllButton = findByClass(uiEl, 'audio-play-all');

playAllButton.dispatchEvent('click');
logResult('Playback starts on demand', FakeAudio.playCalls[0] === 'audio-1.ogg');

playAllButton.dispatchEvent('click');
logResult('Playback stops on second click', playAllButton.textContent === translate('player.dialogue.playAll'));

playAllButton.dispatchEvent('click');
logResult('Playback restarts after stop', FakeAudio.playCalls[1] === 'audio-1.ogg');

FakeAudio.instances[0].trigger('ended');
logResult('Queued timer cleared on manual stop', (() => {
  const timersBeforeStop = pendingTimeouts.length;
  playAllButton.dispatchEvent('click');
  const timersAfterStop = pendingTimeouts.length;
  flushPendingTimeouts();
  return timersBeforeStop === 1 && timersAfterStop === 0 && FakeAudio.playCalls.length === 2;
})());

globalThis.setTimeout = originalSetTimeout;
globalThis.clearTimeout = originalClearTimeout;
