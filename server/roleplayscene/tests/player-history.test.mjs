class StubElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.eventListeners = {};
    this.attributes = {};
    this.dataset = {};
    this.disabled = false;
    this.type = '';
    this.className = '';
    this.value = '';
    this._innerHTML = '';
    this._textContent = '';
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

  removeEventListener(type, handler) {
    if (!this.eventListeners[type]) {
      return;
    }
    this.eventListeners[type] = this.eventListeners[type].filter(cb => cb !== handler);
  }

  dispatchEvent(type, event = {}) {
    const handlers = this.eventListeners[type] || [];
    const payload = { ...event };
    if (!payload.target) {
      payload.target = this;
    }
    handlers.forEach(handler => handler(payload));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }
}

class StubDocument {
  constructor() {
    this.body = new StubElement('body');
  }

  createElement(tagName) {
    return new StubElement(tagName);
  }
}

globalThis.document = new StubDocument();

globalThis.Audio = class {
  constructor() {}
  play() { return Promise.resolve(); }
  pause() {}
  addEventListener() {}
  removeEventListener() {}
};

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

function findButtonByText(root, text) {
  return findElement(root, el => el.tagName === 'button' && el.textContent === text);
}

function getHistoryButtons(root) {
  const list = findElement(root, el => (el.className || '') === 'player-history-list');
  if (!list) {
    return [];
  }
  const buttons = [];
  for (const item of list.children || []) {
    for (const child of item.children || []) {
      if (child.tagName === 'button') {
        buttons.push(child);
      }
    }
  }
  return buttons;
}

const HISTORY_LABEL_MAX_LENGTH = 30;

function truncateHistoryLabel(text) {
  if (!text) {
    return text;
  }
  const glyphs = Array.from(text);
  if (glyphs.length <= HISTORY_LABEL_MAX_LENGTH) {
    return text;
  }
  const sliceLength = Math.max(1, HISTORY_LABEL_MAX_LENGTH - 1);
  return `${glyphs.slice(0, sliceLength).join('')}…`;
}

function logResult(label, condition) {
  const status = condition ? 'OK' : 'FAIL';
  console.log(`${status}: ${label}`);
}

const { renderPlayer } = await import('../scripts/player/player.js');
const { Store } = await import('../scripts/state.js');
const { SceneType } = await import('../scripts/model.js');

const store = new Store();

const project = {
  meta: { title: 'History Demo' },
  scenes: [
    {
      id: 'start',
      type: SceneType.START,
      image: null,
      backgroundAudio: null,
      dialogue: [{
        text:
          'This is a very long first line that should be truncated in the history panel to keep things tidy.',
        audio: null,
      }],
      choices: [
        { id: 'c1', label: 'To middle', nextSceneId: 'middle' },
        { id: 'c2', label: 'Alternate path', nextSceneId: 'alt' },
      ],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'middle',
      type: SceneType.INTERMEDIATE,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'Middle scene', audio: null }],
      choices: [
        { id: 'c3', label: 'To end', nextSceneId: 'end' },
      ],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'alt',
      type: SceneType.INTERMEDIATE,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'Alternate route', audio: null }],
      choices: [
        { id: 'c4', label: 'To end', nextSceneId: 'end' },
      ],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'end',
      type: SceneType.END,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'The end', audio: null }],
      choices: [],
      autoNextSceneId: null,
      notes: '',
    },
  ],
};

store.set({ project });

const stageHost = new StubElement('div');
const uiHost = new StubElement('div');

const cleanup = renderPlayer(store, stageHost, uiHost, () => {});

const beginButton = findButtonByText(uiHost, 'Begin Story');
logResult('Begin Story button renders', Boolean(beginButton));
if (beginButton) {
  beginButton.dispatchEvent('click');
}

let historyButtons = getHistoryButtons(uiHost);
logResult('History starts with single entry', historyButtons.length === 1);
logResult(
  'Initial entry marked current',
  historyButtons.length === 1 && historyButtons[0].disabled && historyButtons[0].getAttribute('aria-current') === 'step',
);

const initialHistoryButton = historyButtons[0];
const longFirstLine = project.scenes[0].dialogue[0].text;
const expectedTruncatedLabel = truncateHistoryLabel(longFirstLine);
logResult('History entry label truncated', initialHistoryButton?.textContent === expectedTruncatedLabel);
logResult('History entry title retains full text', initialHistoryButton?.getAttribute('title') === longFirstLine);
logResult('History entry aria-label retains full text', initialHistoryButton?.getAttribute('aria-label') === longFirstLine);

let backButton = findElement(uiHost, el => (el.className || '') === 'player-history-back');
logResult('Back button disabled at start', Boolean(backButton?.disabled));

const toMiddle = findButtonByText(uiHost, 'To middle');
if (toMiddle) {
  toMiddle.dispatchEvent('click');
}

historyButtons = getHistoryButtons(uiHost);
logResult(
  'Second scene appended to history',
  historyButtons.length === 2 && historyButtons[1]?.dataset?.sceneId === 'middle',
);

backButton = findElement(uiHost, el => (el.className || '') === 'player-history-back');
logResult('Back button enabled after branching', Boolean(backButton) && backButton.disabled === false);
if (backButton) {
  backButton.dispatchEvent('click');
}

let forwardButton = findElement(uiHost, el => (el.className || '') === 'player-history-forward');
logResult('Forward available after going back', Boolean(forwardButton) && forwardButton.disabled === false);

const altChoice = findButtonByText(uiHost, 'Alternate path');
if (altChoice) {
  altChoice.dispatchEvent('click');
}

historyButtons = getHistoryButtons(uiHost);
logResult(
  'Forward history trimmed on new branch',
  historyButtons.length === 2 && historyButtons[1]?.dataset?.sceneId === 'alt',
);

const toEnd = findButtonByText(uiHost, 'To end');
if (toEnd) {
  toEnd.dispatchEvent('click');
}

historyButtons = getHistoryButtons(uiHost);
logResult('End scene added to history', historyButtons.length === 3 && historyButtons[2]?.dataset?.sceneId === 'end');

const jumpToStart = historyButtons[0];
if (jumpToStart) {
  jumpToStart.dispatchEvent('click');
}

forwardButton = findElement(uiHost, el => (el.className || '') === 'player-history-forward');
logResult('Forward retained after jump', Boolean(forwardButton) && forwardButton.disabled === false);

const toMiddleAgain = findButtonByText(uiHost, 'To middle');
if (toMiddleAgain) {
  toMiddleAgain.dispatchEvent('click');
}

historyButtons = getHistoryButtons(uiHost);
logResult(
  'Branching after jump clears future entries',
  historyButtons.length === 2 && historyButtons[1]?.dataset?.sceneId === 'middle',
);

cleanup();

const previewStageHost = new StubElement('div');
const previewUiHost = new StubElement('div');
const previewCleanup = renderPlayer(store, previewStageHost, previewUiHost, () => {}, { initialSceneId: 'middle' });

const previewBeginButton = findButtonByText(previewUiHost, 'Begin Story');
logResult('Initial scene preview skips intro', !previewBeginButton);
const previewHistoryButtons = getHistoryButtons(previewUiHost);
logResult(
  'Initial scene preview starts history at requested scene',
  previewHistoryButtons.length === 1 && previewHistoryButtons[0]?.dataset?.sceneId === 'middle',
);
const previewNextChoice = findButtonByText(previewUiHost, 'To end');
logResult('Initial scene preview renders requested scene choices', Boolean(previewNextChoice));

previewCleanup();
