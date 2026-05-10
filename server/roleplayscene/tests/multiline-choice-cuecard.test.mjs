import assert from 'node:assert/strict';

class StubElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.eventListeners = {};
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.value = '';
    this.placeholder = '';
    this.rows = 0;
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this._textContent = '';
    this._innerHTML = '';
    this.classList = {
      add: (...tokens) => {
        const existing = new Set(this.className.split(/\s+/).filter(Boolean));
        tokens.forEach(token => existing.add(token));
        this.className = Array.from(existing).join(' ');
      },
    };
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    nodes.forEach(node => this.appendChild(node));
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
    const handlers = this.eventListeners[type] || [];
    handlers.forEach(handler => handler({
      ...event,
      type,
      target: event.target ?? this,
      stopPropagation: event.stopPropagation ?? (() => {}),
      preventDefault: event.preventDefault ?? (() => {}),
    }));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  contains(target) {
    if (target === this) return true;
    return this.children.some(child => typeof child.contains === 'function' && child.contains(target));
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
    this._innerHTML = '';
  }

  get textContent() {
    if (this.children.length) {
      return this.children.map(child => child.textContent || '').join('');
    }
    return this._textContent;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    this._textContent = '';
  }

  get innerHTML() {
    return this._innerHTML;
  }
}

class StubDocument {
  constructor() {
    this.listeners = {};
  }

  createElement(tagName) {
    return new StubElement(tagName);
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter(cb => cb !== handler);
  }
}

function findElement(root, predicate) {
  if (!root) return null;
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

globalThis.document = new StubDocument();

const { SceneType } = await import('../scripts/model.js');
const { renderInspector } = await import('../scripts/editor/inspector.js');
const { renderPlayerUI } = await import('../scripts/player/ui.js');

const multilineLabel = 'Line one\nLine two <script>alert(1)</script>';
const multilineCueCard = 'Step A\nStep B\nUse "quotes" safely';

const project = {
  meta: { title: 'Multiline' },
  scenes: [
    {
      id: 'scene-1',
      type: SceneType.START,
      image: null,
      dialogue: [{ text: 'hello', audio: null }],
      choices: [{ id: 'choice-1', label: multilineLabel, cueCardText: multilineCueCard, nextSceneId: 'scene-2' }],
    },
    {
      id: 'scene-2',
      type: SceneType.END,
      image: null,
      dialogue: [{ text: 'end', audio: null }],
      choices: [],
    },
  ],
};

const inspectorHost = new StubElement('div');
renderInspector(inspectorHost, project, project.scenes[0], {});

const choiceLabelEditor = findElement(inspectorHost, el => el.dataset?.focusKey === 'choice-label-scene-1-0');
assert(choiceLabelEditor, 'choice label editor should exist');
assert.equal(choiceLabelEditor.tagName, 'textarea', 'choice label editor should be textarea');

const cueCardEditor = findElement(inspectorHost, el => el.dataset?.focusKey === 'choice-cue-card-scene-1-0');
assert(cueCardEditor, 'cue card editor should exist');
assert.equal(cueCardEditor.tagName, 'textarea', 'cue card editor should be textarea');

const stageEl = new StubElement('div');
const uiEl = new StubElement('div');
renderPlayerUI({ stageEl, uiEl, project, scene: project.scenes[0], onChoice: () => {} });

const choiceLabel = findElement(uiEl, el => el.className === 'player-choice-label');
assert(choiceLabel, 'player choice label should render');
assert.equal(choiceLabel.textContent, multilineLabel, 'player choice label should preserve multiline and special characters');

const cueTrigger = findElement(uiEl, el => el.className === 'player-choice-cue-trigger');
assert(cueTrigger, 'cue card trigger should render for cue text');
cueTrigger.dispatchEvent('click');

const cueBody = findElement(uiEl, el => el.className === 'player-cue-body');
assert(cueBody, 'cue body should render');
assert.equal(cueBody.textContent, multilineCueCard, 'cue body should preserve multiline text');
assert.equal(cueBody.innerHTML, '', 'cue body should not inject HTML from cue card content');

console.log('OK: multiline choice and cue card text are editable and safely rendered');
