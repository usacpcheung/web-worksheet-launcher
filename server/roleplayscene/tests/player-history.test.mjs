import assert from 'node:assert/strict';

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
  const list = findElement(root, el => (el.className || '') === 'theater-history-list');
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

function getHistoryButtonLabel(button) {
  return findElement(button, el => (el.className || '') === 'theater-history-label')?.textContent || '';
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
  assert.ok(condition, label);
  console.log(`OK: ${label}`);
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
const findPlayerButtonByText = text => findButtonByText(stageHost, text) || findButtonByText(uiHost, text);
const openChoicesMenu = () => {
  const choicesButton = findPlayerButtonByText('Choices');
  if (choicesButton) {
    choicesButton.dispatchEvent('click');
  }
};

const beginButton = findPlayerButtonByText('Begin Story');
logResult('Begin Story button renders', Boolean(beginButton));
if (beginButton) {
  beginButton.dispatchEvent('click');
}

let historyButtons = getHistoryButtons(stageHost);
logResult('History starts with single entry', historyButtons.length === 1);
logResult(
  'Initial entry marked current',
  historyButtons.length === 1 && historyButtons[0].disabled && historyButtons[0].getAttribute('aria-current') === 'step',
);

const initialHistoryButton = historyButtons[0];
const longFirstLine = project.scenes[0].dialogue[0].text;
const expectedTruncatedLabel = truncateHistoryLabel(longFirstLine);
logResult('History entry label truncated', getHistoryButtonLabel(initialHistoryButton) === expectedTruncatedLabel);
logResult('History entry title retains full text', initialHistoryButton?.getAttribute('title') === longFirstLine);
logResult('History entry aria-label retains full text', initialHistoryButton?.getAttribute('aria-label') === longFirstLine);

let backButton = findElement(stageHost, el => el.tagName === 'button' && el.textContent === '← Back');
logResult('Back button disabled at start', Boolean(backButton?.disabled));

openChoicesMenu();
const toMiddle = findPlayerButtonByText('To middle');
if (toMiddle) {
  toMiddle.dispatchEvent('click');
}

historyButtons = getHistoryButtons(stageHost);
logResult(
  'Second scene appended to history',
  historyButtons.length === 2 && historyButtons[1]?.dataset?.sceneId === 'middle',
);

backButton = findElement(stageHost, el => el.tagName === 'button' && el.textContent === '← Back');
logResult('Back button enabled after branching', Boolean(backButton) && backButton.disabled === false);
if (backButton) {
  backButton.dispatchEvent('click');
}

let forwardButton = findElement(stageHost, el => el.tagName === 'button' && el.textContent === 'Forward →');
logResult('Forward available after going back', Boolean(forwardButton) && forwardButton.disabled === false);

openChoicesMenu();
const altChoice = findPlayerButtonByText('Alternate path');
if (altChoice) {
  altChoice.dispatchEvent('click');
}

historyButtons = getHistoryButtons(stageHost);
logResult(
  'Forward history trimmed on new branch',
  historyButtons.length === 2 && historyButtons[1]?.dataset?.sceneId === 'alt',
);

openChoicesMenu();
const toEnd = findPlayerButtonByText('To end');
if (toEnd) {
  toEnd.dispatchEvent('click');
}

historyButtons = getHistoryButtons(stageHost);
logResult('End scene added to history', historyButtons.length === 3 && historyButtons[2]?.dataset?.sceneId === 'end');

const jumpToStart = historyButtons[0];
if (jumpToStart) {
  jumpToStart.dispatchEvent('click');
}

forwardButton = findElement(stageHost, el => el.tagName === 'button' && el.textContent === 'Forward →');
logResult('Forward retained after jump', Boolean(forwardButton) && forwardButton.disabled === false);

openChoicesMenu();
const toMiddleAgain = findPlayerButtonByText('To middle');
if (toMiddleAgain) {
  toMiddleAgain.dispatchEvent('click');
}

historyButtons = getHistoryButtons(stageHost);
logResult(
  'Branching after jump clears future entries',
  historyButtons.length === 2 && historyButtons[1]?.dataset?.sceneId === 'middle',
);

cleanup();

const previewStageHost = new StubElement('div');
const previewUiHost = new StubElement('div');
const previewCleanup = renderPlayer(store, previewStageHost, previewUiHost, () => {}, { initialSceneId: 'middle' });

const previewBeginButton = findButtonByText(previewStageHost, 'Begin Story') || findButtonByText(previewUiHost, 'Begin Story');
logResult('Initial scene preview skips intro', !previewBeginButton);
const previewHistoryButtons = getHistoryButtons(previewStageHost);
logResult(
  'Initial scene preview starts history at requested scene',
  previewHistoryButtons.length === 1 && previewHistoryButtons[0]?.dataset?.sceneId === 'middle',
);
const previewChoicesButton = findButtonByText(previewStageHost, 'Choices') || findButtonByText(previewUiHost, 'Choices');
if (previewChoicesButton) {
  previewChoicesButton.dispatchEvent('click');
}
const previewNextChoice = findButtonByText(previewStageHost, 'To end') || findButtonByText(previewUiHost, 'To end');
logResult('Initial scene preview renders requested scene choices', Boolean(previewNextChoice));

previewCleanup();

const localeStore = new Store();
const localeProject = {
  meta: { title: 'Locale Position Demo' },
  scenes: [
    {
      id: 'locale-start',
      type: SceneType.START,
      image: null,
      backgroundAudio: null,
      dialogue: [
        { text: 'First visible line', audio: null },
        { text: 'Second visible line', audio: null },
      ],
      choices: [
        {
          id: 'locale-choice',
          label: 'Go end',
          nextSceneId: 'locale-end',
          cueCardText: 'Remember the second line.',
        },
      ],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'locale-end',
      type: SceneType.END,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'Locale end', audio: null }],
      choices: [],
      autoNextSceneId: null,
      notes: '',
    },
  ],
};
localeStore.set({ project: localeProject });

const localeStageHost = new StubElement('div');
const localeUiHost = new StubElement('div');
const discussionSession = {
  snapshot: () => ({}),
  getText: () => '',
  setText: () => {},
  hasUndo: () => false,
  hasAnyText: () => false,
  getMessage: () => '',
};
const localeCleanup = renderPlayer(localeStore, localeStageHost, localeUiHost, () => {}, { discussionSession });
const findLocaleButtonByText = text => findButtonByText(localeStageHost, text) || findButtonByText(localeUiHost, text);
const getDialogueText = () => findElement(
  localeStageHost,
  el => (el.className || '') === 'theater-dialogue-text',
)?.textContent || '';

findLocaleButtonByText('Begin Story')?.dispatchEvent('click');
findLocaleButtonByText('Next')?.dispatchEvent('click');
logResult('Second dialogue is active before locale change', getDialogueText() === 'Second visible line');

localeStore.setLocale('zh-Hant');
logResult('Locale change keeps active dialogue page', getDialogueText() === 'Second visible line');

localeStore.setLocale('en');
findLocaleButtonByText('Choices')?.dispatchEvent('click');
logResult('Choice menu is open before locale change', Boolean(findLocaleButtonByText('Go end')));
localeStore.setLocale('zh-Hant');
logResult('Locale change keeps choice menu open', Boolean(findLocaleButtonByText('Go end')));

const cueTrigger = findElement(
  localeStageHost,
  el => (el.className || '') === 'player-choice-cue-trigger',
);
cueTrigger?.dispatchEvent('click');
const getCueText = () => findElement(
  localeStageHost,
  el => (el.className || '') === 'player-discussion-cue-text',
)?.textContent || '';
logResult('Cue discussion overlay is open before locale change', getCueText() === 'Remember the second line.');
localeStore.setLocale('en');
logResult('Locale change keeps cue discussion overlay open', getCueText() === 'Remember the second line.');

localeStore.setLocale('en');
findLocaleButtonByText('Utilities')?.dispatchEvent('click');
findLocaleButtonByText('Discussion')?.dispatchEvent('click');
logResult('Discussion overlay is open before locale change', Boolean(findElement(
  localeStageHost,
  el => el.tagName === 'textarea' && (el.className || '') === 'player-discussion-textarea',
)));
localeStore.setLocale('zh-Hant');
logResult('Locale change keeps discussion overlay open', Boolean(findElement(
  localeStageHost,
  el => el.tagName === 'textarea' && (el.className || '') === 'player-discussion-textarea',
)));

localeCleanup();
