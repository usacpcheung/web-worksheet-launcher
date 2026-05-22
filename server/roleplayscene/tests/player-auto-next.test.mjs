class StubElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.eventListeners = {};
    this.attributes = {};
    this.dataset = {};
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.type = '';
    this.title = '';
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
    return this._innerHTML || '';
  }

  addEventListener(type, handler) {
    if (!this.eventListeners[type]) {
      this.eventListeners[type] = [];
    }
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

globalThis.document = new StubDocument();

globalThis.Audio = class {
  constructor() {}
  play() { return Promise.resolve(); }
};

const { renderPlayerUI } = await import('../scripts/player/ui.js');
const { SceneType } = await import('../scripts/model.js');

function createStage() {
  return new StubElement('div');
}

function createUIRoot() {
  return new StubElement('div');
}

function findFirst(root, predicate) {
  if (predicate(root)) {
    return root;
  }
  for (const child of root.children) {
    const result = findFirst(child, predicate);
    if (result) return result;
  }
  return null;
}

function findButtonByText(root, text) {
  return findFirst(root, (el) => el.tagName === 'button' && el.textContent === text);
}

function renderScene(scene, onChoice = () => {}) {
  const stageEl = createStage();
  const uiEl = createUIRoot();
  const project = { scenes: [scene, { id: 'other', type: SceneType.END, choices: [] }] };
  renderPlayerUI({ stageEl, uiEl, project, scene, onChoice });
  return { stageEl, uiEl };
}

function logResult(label, condition) {
  const status = condition ? 'OK' : 'FAIL';
  console.log(`${status}: ${label}`);
}

// Test: no autoNext renders placeholder text
let scene = {
  id: 'scene-1',
  type: SceneType.INTERMEDIATE,
  dialogue: [{ text: 'Hi' }],
  choices: [],
  autoNextSceneId: null,
};

let { stageEl, uiEl } = renderScene(scene);
findButtonByText(stageEl, 'Next')?.dispatchEvent('click');
let continueButton = findButtonByText(stageEl, 'Continue');
const emptyMessage = findFirst(stageEl, el => el.className === 'empty');
logResult('No auto-advance shows placeholder', !continueButton && !!emptyMessage);

// Test: autoNext renders enabled button and triggers callback
scene = {
  id: 'scene-2',
  type: SceneType.INTERMEDIATE,
  dialogue: [{ text: 'Line' }],
  choices: [],
  autoNextSceneId: 'other',
};

let chosen = null;
({ stageEl, uiEl } = renderScene(scene, (nextId) => { chosen = nextId; }));
findButtonByText(stageEl, 'Next')?.dispatchEvent('click');
continueButton = findButtonByText(stageEl, 'Continue');
logResult('Continue button rendered when autoNext set', !!continueButton);
if (continueButton) {
  continueButton.dispatchEvent('click');
}
logResult('Continue button triggers navigation', chosen === 'other');

// Test: disabled when target missing
scene = {
  id: 'scene-3',
  type: SceneType.INTERMEDIATE,
  dialogue: [{ text: 'Line' }],
  choices: [],
  autoNextSceneId: 'missing',
};

({ stageEl, uiEl } = renderScene(scene));
findButtonByText(stageEl, 'Next')?.dispatchEvent('click');
continueButton = findButtonByText(stageEl, 'Continue');
logResult('Continue button disabled when destination missing', !!continueButton && continueButton.disabled);

// Test: hidden when choices exist
scene = {
  id: 'scene-4',
  type: SceneType.INTERMEDIATE,
  dialogue: [{ text: 'Line' }],
  choices: [{ id: 'c1', label: 'Go', nextSceneId: 'other' }],
  autoNextSceneId: 'other',
};

({ stageEl, uiEl } = renderScene(scene));
findButtonByText(stageEl, 'Next')?.dispatchEvent('click');
continueButton = findButtonByText(stageEl, 'Continue');
logResult('Auto-advance suppressed when choices exist', continueButton === null);
