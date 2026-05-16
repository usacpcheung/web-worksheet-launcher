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
    handlers.forEach(handler => handler({ ...event, target: event.target ?? this }));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
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

class FakeAudio {
  constructor(src) {
    this.src = src;
    this.loop = false;
    this.paused = true;
    this.currentTime = 0;
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
    const handlers = this._listeners[type] || [];
    handlers.forEach(handler => handler({ ...event, target: event.target ?? this }));
  }
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

function findByText(root, text) {
  if (!root) {
    return null;
  }
  const hasChildren = (root.children?.length || 0) > 0;
  if (root.textContent === text && (!hasChildren || root.tagName === 'button')) {
    return root;
  }
  for (const child of root.children || []) {
    const match = findByText(child, text);
    if (match) {
      return match;
    }
  }
  return null;
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

function getLatestInstanceForSrc(src) {
  for (let index = FakeAudio.instances.length - 1; index >= 0; index -= 1) {
    const candidate = FakeAudio.instances[index];
    if (candidate?.src === src) {
      return candidate;
    }
  }
  return null;
}

function cloneProject(project) {
  return {
    meta: { ...project.meta },
    scenes: project.scenes.map(scene => ({
      ...scene,
      image: scene.image ? { ...scene.image } : null,
      backgroundAudio: scene.backgroundAudio ? { ...scene.backgroundAudio } : null,
      dialogue: scene.dialogue.map(line => ({ ...line })),
      choices: scene.choices.map(choice => ({ ...choice })),
    })),
  };
}

globalThis.document = new StubDocument();
globalThis.Audio = FakeAudio;

const { renderPlayer } = await import('../scripts/player/player.js');
const { Store } = await import('../scripts/state.js');
const { SceneType } = await import('../scripts/model.js');


function createIntroOnlyProject(startBackgroundAudio) {
  return {
    meta: { title: 'Intro Only' },
    scenes: [
      {
        id: 'start-1',
        type: SceneType.START,
        image: null,
        backgroundAudio: startBackgroundAudio,
        dialogue: [{ text: 'Welcome', audio: null }],
        choices: [],
        autoNextSceneId: null,
        notes: '',
      },
    ],
  };
}

function renderWithProject(project, extraState = {}) {
  const store = new Store();
  store.set({ project, ...extraState });
  const stageHost = new StubElement('div');
  const uiHost = new StubElement('div');
  const cleanup = renderPlayer(store, stageHost, uiHost, () => {});
  return { store, stageHost, uiHost, cleanup };
}

resetAudioSpies();

{
  const introProject = createIntroOnlyProject({ name: 'Loop', objectUrl: 'bg-loop.ogg' });
  const { uiHost, cleanup } = renderWithProject(introProject, { audioGate: true });

  const introInstance = getLatestInstanceForSrc('bg-loop.ogg');
  const introSlider = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');
  const introMute = findByText(uiHost, 'Mute background music');

  logResult('Intro plays start background when gate already open', FakeAudio.playCalls[0] === 'bg-loop.ogg');
  logResult('Intro renders controls for start background audio', Boolean(introSlider) && Boolean(introMute));

  if (introSlider) {
    introSlider.value = '0.65';
    introSlider.dispatchEvent('input', { target: introSlider });
  }

  logResult('Intro volume control updates background state', Math.abs((introInstance?.volume ?? 0) - 0.65) < 0.001);

  if (introMute) {
    introMute.dispatchEvent('click');
  }

  logResult('Intro mute control pauses active background', introInstance?.paused === true);

  const introUnmute = findByText(uiHost, 'Unmute background music');
  if (introUnmute) {
    introUnmute.dispatchEvent('click');
  }

  const resumedInstance = getLatestInstanceForSrc('bg-loop.ogg');
  logResult('Intro unmute resumes background playback', resumedInstance?.paused === false);
  logResult('Intro unmute keeps selected volume', Math.abs((resumedInstance?.volume ?? 0) - 0.65) < 0.001);

  const introInstancesBeforeBegin = FakeAudio.instances.length;
  const beginBtn = findByText(uiHost, 'Begin Story');
  if (beginBtn) {
    beginBtn.dispatchEvent('click');
  }

  logResult(
    'Begin Story does not create duplicate background instance when source is unchanged',
    FakeAudio.instances.length === introInstancesBeforeBegin,
  );

  cleanup();
}

resetAudioSpies();

{
  const introProjectWithoutAudio = createIntroOnlyProject(null);
  const { uiHost, cleanup } = renderWithProject(introProjectWithoutAudio, { audioGate: true });
  const introSlider = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');

  logResult('Intro does not play background when start has no background audio', FakeAudio.playCalls.length === 0);
  logResult('Intro does not render controls when start has no background audio', !introSlider);

  cleanup();
}

resetAudioSpies();

{
  const introProject = createIntroOnlyProject({ name: 'Loop', objectUrl: 'bg-loop.ogg' });
  const { uiHost, cleanup } = renderWithProject(introProject);

  const introSlider = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');
  const introUnmute = findByText(uiHost, 'Unmute background music');
  logResult('Intro renders disabled background controls before audio gate opens', Boolean(introSlider?.disabled) && Boolean(introUnmute));
  logResult('Intro does not autoplay before Begin Story', FakeAudio.playCalls.length === 0);

  if (introUnmute) {
    introUnmute.dispatchEvent('click');
  }

  logResult('Intro unmute starts background playback', FakeAudio.playCalls[0] === 'bg-loop.ogg');
  const introMute = findByText(uiHost, 'Mute background music');
  logResult('Intro unmute enables volume controls', Boolean(introSlider) && !introSlider.disabled && Boolean(introMute));

  cleanup();
}

resetAudioSpies();

{
  const introProject = createIntroOnlyProject({ name: 'Loop', objectUrl: 'bg-loop.ogg' });
  const { uiHost, cleanup } = renderWithProject(introProject);

  const startButton = findByText(uiHost, 'Begin Story');
  if (startButton) {
    startButton.dispatchEvent('click');
  }

  logResult('Default off intro preference prevents Begin Story background playback', FakeAudio.playCalls.length === 0);

  cleanup();
}

resetAudioSpies();

const store = new Store();
const project = {
  meta: { title: 'Audio Test' },
  scenes: [
    {
      id: 'start-1',
      type: SceneType.START,
      image: null,
      backgroundAudio: { name: 'Loop', objectUrl: 'bg-loop.ogg' },
      dialogue: [{ text: 'Welcome', audio: { objectUrl: 'welcome.ogg' } }],
      choices: [
        { id: 'choice-quiet', label: 'To Quiet', nextSceneId: 'quiet-1' },
      ],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'quiet-1',
      type: SceneType.INTERMEDIATE,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'So quiet here', audio: null }],
      choices: [
        { id: 'choice-override', label: 'To Override', nextSceneId: 'override-1' },
      ],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'override-1',
      type: SceneType.INTERMEDIATE,
      image: null,
      backgroundAudio: { name: 'Dramatic', objectUrl: 'dramatic.ogg' },
      dialogue: [{ text: 'Things escalate', audio: { objectUrl: 'rise.ogg' } }],
      choices: [
        { id: 'choice-back', label: 'Back to Quiet', nextSceneId: 'quiet-2' },
      ],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'quiet-2',
      type: SceneType.INTERMEDIATE,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'Peace returns', audio: null }],
      choices: [
        { id: 'choice-end', label: 'To End', nextSceneId: 'end-1' },
      ],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'end-1',
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

logResult('Background idle before Begin Story', FakeAudio.playCalls.length === 0);

const introUnmuteButton = findByText(uiHost, 'Unmute background music');
logResult('Background controls render before Begin Story', Boolean(introUnmuteButton));
if (introUnmuteButton) {
  introUnmuteButton.dispatchEvent('click');
}

const introVolumeSlider = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');
logResult('Background controls enable after intro unmute', Boolean(introVolumeSlider) && !introVolumeSlider.disabled);
if (introVolumeSlider) {
  introVolumeSlider.value = '0.6';
  introVolumeSlider.dispatchEvent('input', { target: introVolumeSlider });
}

const introPlayCountAfterUnmute = FakeAudio.playCalls.length;
const startButton = findByText(uiHost, 'Begin Story');
logResult('Begin Story button renders', Boolean(startButton));
if (startButton) {
  startButton.dispatchEvent('click');
}

const backgroundInstance = FakeAudio.instances[0] ?? null;
logResult('Background track plays after Begin Story', FakeAudio.playCalls[0] === 'bg-loop.ogg');
logResult('Begin Story does not duplicate already playing intro background', FakeAudio.playCalls.length === introPlayCountAfterUnmute);
logResult('Background track loops enabled', backgroundInstance?.loop === true);
logResult('Background track playing', backgroundInstance?.paused === false);
logResult('Background track uses intro volume preference after Begin Story', Math.abs((backgroundInstance?.volume ?? 0) - 0.6) < 0.001);

const volumeSliderInitial = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');
logResult('Background volume slider renders', Boolean(volumeSliderInitial));
logResult(
  'Background slider keeps intro volume preference',
  Boolean(volumeSliderInitial) && Math.abs(Number(volumeSliderInitial.value) - 0.6) < 0.001,
);

if (volumeSliderInitial) {
  volumeSliderInitial.value = '0.7';
  volumeSliderInitial.dispatchEvent('input', { target: volumeSliderInitial });
}

logResult(
  'Background volume updates active audio',
  Math.abs((backgroundInstance?.volume ?? 0) - 0.7) < 0.001,
);

const initialPlayCount = FakeAudio.playCalls.length;

const clonedProject = cloneProject(store.get().project);
store.set({ project: clonedProject });

const volumeSliderAfterRerender = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');
logResult('Background slider persists across re-render', Boolean(volumeSliderAfterRerender));
logResult(
  'Background slider retains value after re-render',
  Boolean(volumeSliderAfterRerender) && Math.abs(Number(volumeSliderAfterRerender.value) - 0.7) < 0.001,
);
logResult(
  'Background track persists across re-render',
  FakeAudio.playCalls.length === initialPlayCount && FakeAudio.instances[0] === backgroundInstance && backgroundInstance?.paused === false,
);

let muteButton = findByText(uiHost, 'Mute background music');
logResult('Mute button renders', Boolean(muteButton));
if (muteButton) {
  muteButton.dispatchEvent('click');
}

logResult('Background track stops when muted', FakeAudio.pauseCalls.includes('bg-loop.ogg'));
logResult('Background track paused state after mute', backgroundInstance?.paused === true);

const sliderWhileMuted = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');
logResult('Volume slider disabled while muted', Boolean(sliderWhileMuted?.disabled));

const unmuteButton = findByText(uiHost, 'Unmute background music');
logResult('Unmute button renders after toggle', Boolean(unmuteButton));
if (unmuteButton) {
  unmuteButton.dispatchEvent('click');
}

let resumedInstance = getLatestInstanceForSrc('bg-loop.ogg');
logResult('Background track restarts after unmute', FakeAudio.playCalls.length === initialPlayCount + 1);
logResult('Background track resumes playback', resumedInstance?.paused === false);
logResult(
  'Background track retains volume after unmute',
  Math.abs((resumedInstance?.volume ?? 0) - 0.7) < 0.001,
);

muteButton = findByText(uiHost, 'Mute background music');
logResult('Mute button label resets after unmute', Boolean(muteButton));

const sliderAfterUnmute = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');
logResult('Volume slider enabled after unmute', Boolean(sliderAfterUnmute) && !sliderAfterUnmute.disabled);

const linePlayButton = findByText(uiHost, '▶️ Play line');
logResult('Dialogue line play button renders', Boolean(linePlayButton));

if (linePlayButton) {
  linePlayButton.dispatchEvent('click');
}

const dialogueInstance = getLatestInstanceForSrc('welcome.ogg');
logResult('Dialogue clip starts playback', FakeAudio.playCalls.includes('welcome.ogg'));
resumedInstance = getLatestInstanceForSrc('bg-loop.ogg');
logResult(
  'Background ducks during dialogue playback',
  Math.abs((resumedInstance?.volume ?? 0) - 0.05) < 0.001,
);

muteButton = findByText(uiHost, 'Mute background music');
if (muteButton) {
  muteButton.dispatchEvent('click');
}

logResult('Background pauses when muted during duck', resumedInstance?.paused === true);

const unmuteDuringDuck = findByText(uiHost, 'Unmute background music');
if (unmuteDuringDuck) {
  unmuteDuringDuck.dispatchEvent('click');
}

resumedInstance = getLatestInstanceForSrc('bg-loop.ogg');
logResult('Background resumes after unmute while ducked', resumedInstance?.paused === false);
logResult(
  'Background remains ducked after unmute',
  Math.abs((resumedInstance?.volume ?? 0) - 0.05) < 0.001,
);

dialogueInstance?.trigger?.('ended');

resumedInstance = getLatestInstanceForSrc('bg-loop.ogg');
logResult(
  'Background restores after dialogue finishes',
  Math.abs((resumedInstance?.volume ?? 0) - 0.7) < 0.001,
);

const sliderAfterDialogue = findElement(uiHost, el => el.tagName === 'input' && el.type === 'range');
if (sliderAfterDialogue) {
  sliderAfterDialogue.value = '0';
  sliderAfterDialogue.dispatchEvent('input', { target: sliderAfterDialogue });
}

resumedInstance = getLatestInstanceForSrc('bg-loop.ogg');
logResult(
  'Background reflects zeroed slider before duck',
  Math.abs(resumedInstance?.volume ?? 1) < 0.001,
);

const replayLineButton = findByText(uiHost, '▶️ Play line');
logResult('Dialogue line play button available for replay', Boolean(replayLineButton));

if (replayLineButton) {
  replayLineButton.dispatchEvent('click');
}

const zeroVolumeDialogue = getLatestInstanceForSrc('welcome.ogg');
logResult('Dialogue clip replays for zero-volume check', FakeAudio.playCalls.filter(src => src === 'welcome.ogg').length >= 2);
resumedInstance = getLatestInstanceForSrc('bg-loop.ogg');
logResult(
  'Background stays silent when ducked from zero volume',
  Math.abs(resumedInstance?.volume ?? 1) < 0.001,
);

zeroVolumeDialogue?.trigger?.('ended');

resumedInstance = getLatestInstanceForSrc('bg-loop.ogg');
logResult(
  'Background remains at zero after duck restore',
  Math.abs(resumedInstance?.volume ?? 1) < 0.001,
);

if (sliderAfterDialogue) {
  sliderAfterDialogue.value = '0.7';
  sliderAfterDialogue.dispatchEvent('input', { target: sliderAfterDialogue });
}

resumedInstance = getLatestInstanceForSrc('bg-loop.ogg');
logResult(
  'Background slider restored to previous volume after zero check',
  Math.abs((resumedInstance?.volume ?? 0) - 0.7) < 0.001,
);

const pauseCountBeforeQuiet = FakeAudio.pauseCalls.length;
const instanceCountBeforeQuiet = FakeAudio.instances.length;
const quietChoice = findByText(uiHost, 'To Quiet');
logResult('To Quiet choice renders', Boolean(quietChoice));
if (quietChoice) {
  quietChoice.dispatchEvent('click');
}

logResult('Background loop continues into silent scene', FakeAudio.pauseCalls.length === pauseCountBeforeQuiet);
logResult(
  'Silent scene reuses default background instance',
  FakeAudio.instances.length === instanceCountBeforeQuiet && FakeAudio.instances[FakeAudio.instances.length - 1] === resumedInstance,
);
logResult('Background loop still playing during silent scene', resumedInstance?.paused === false);

const playCountBeforeOverride = FakeAudio.playCalls.length;
const pauseCountBeforeOverride = FakeAudio.pauseCalls.length;
const overrideChoice = findByText(uiHost, 'To Override');
logResult('To Override choice renders', Boolean(overrideChoice));
if (overrideChoice) {
  overrideChoice.dispatchEvent('click');
}

const overrideInstance = getLatestInstanceForSrc('dramatic.ogg');
logResult(
  'Override pauses default loop',
  FakeAudio.pauseCalls.length === pauseCountBeforeOverride + 1
    && FakeAudio.pauseCalls[FakeAudio.pauseCalls.length - 1] === 'bg-loop.ogg',
);
logResult(
  'Override track starts playback',
  FakeAudio.playCalls.length === playCountBeforeOverride + 1
    && FakeAudio.playCalls[FakeAudio.playCalls.length - 1] === 'dramatic.ogg',
);
logResult('Override track active', overrideInstance?.src === 'dramatic.ogg' && overrideInstance?.paused === false);

const overridePlayButton = findByText(uiHost, '▶️ Play line');
logResult('Override dialogue line button renders', Boolean(overridePlayButton));

if (overridePlayButton) {
  overridePlayButton.dispatchEvent('click');
}

const overrideDialogue = getLatestInstanceForSrc('rise.ogg');
logResult('Override dialogue clip starts', FakeAudio.playCalls.includes('rise.ogg'));

const dramaticDuringDialogue = getLatestInstanceForSrc('dramatic.ogg');
logResult(
  'Override background ducks during dialogue',
  Math.abs((dramaticDuringDialogue?.volume ?? 0) - 0.05) < 0.001,
);

overrideDialogue?.trigger?.('ended');

const dramaticAfterDialogue = getLatestInstanceForSrc('dramatic.ogg');
logResult(
  'Override background restores after dialogue',
  Math.abs((dramaticAfterDialogue?.volume ?? 0) - 0.7) < 0.001,
);

const playCountBeforeReturn = FakeAudio.playCalls.length;
const pauseCountBeforeReturn = FakeAudio.pauseCalls.length;
const returnChoice = findByText(uiHost, 'Back to Quiet');
logResult('Back to Quiet choice renders', Boolean(returnChoice));
if (returnChoice) {
  returnChoice.dispatchEvent('click');
}

const fallbackResumeInstance = getLatestInstanceForSrc('bg-loop.ogg');
logResult(
  'Override track stops when leaving override scene',
  FakeAudio.pauseCalls.length === pauseCountBeforeReturn + 1
    && FakeAudio.pauseCalls[FakeAudio.pauseCalls.length - 1] === 'dramatic.ogg',
);
logResult(
  'Fallback resumes after override scene',
  FakeAudio.playCalls.length === playCountBeforeReturn + 1
    && FakeAudio.playCalls[FakeAudio.playCalls.length - 1] === 'bg-loop.ogg',
);
logResult('Fallback playing after override', fallbackResumeInstance?.src === 'bg-loop.ogg' && fallbackResumeInstance?.paused === false);

const pauseCountBeforeEnd = FakeAudio.pauseCalls.length;
const instanceCountBeforeEnd = FakeAudio.instances.length;
const endChoice = findByText(uiHost, 'To End');
logResult('To End choice renders', Boolean(endChoice));
if (endChoice) {
  endChoice.dispatchEvent('click');
}

logResult('Fallback persists on End scene', FakeAudio.pauseCalls.length === pauseCountBeforeEnd);
logResult(
  'End scene keeps current background instance',
  FakeAudio.instances.length === instanceCountBeforeEnd
    && FakeAudio.instances[FakeAudio.instances.length - 1]?.src === 'bg-loop.ogg',
);

const pauseCountBeforeCleanup = FakeAudio.pauseCalls.length;
cleanup();
logResult(
  'Cleanup stops background audio',
  FakeAudio.pauseCalls.length === pauseCountBeforeCleanup + 1
    && FakeAudio.pauseCalls[FakeAudio.pauseCalls.length - 1] === 'bg-loop.ogg',
);
