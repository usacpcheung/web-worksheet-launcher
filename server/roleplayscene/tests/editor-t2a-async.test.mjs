import test from 'node:test';
import assert from 'node:assert/strict';

import { renderEditor } from '../scripts/editor/editor.js';
import { createProject, createScene, SceneType } from '../scripts/model.js';

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
    this.children.push(child);
    if (this.tagName === 'select' && !this.value && child?.tagName === 'option') {
      this.value = child.value || '';
    }
    return child;
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
    const focusMatch = String(selector).match(/^\[data-focus-key="(.+)"\]$/);
    if (!focusMatch) return null;
    return findElement(this, (element) => element.dataset?.focusKey === focusMatch[1]);
  }

  focus() {}
}

class StubDocument {
  constructor() {
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
