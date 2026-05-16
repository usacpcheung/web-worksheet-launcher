// Schema helpers and factories
import { newId } from './utils/id.js';

export const SceneType = Object.freeze({
  START: 'start',
  INTERMEDIATE: 'intermediate',
  END: 'end',
});

export const MAX_DIALOGUE_LINES = 3;

function normaliseDialogueLine(line = {}) {
  return {
    text: line.text ?? '',
    audio: line.audio
      ? {
        name: line.audio.name ?? '',
        objectUrl: line.audio.objectUrl ?? null,
        blob: line.audio.blob ?? null,
      }
      : null,
  };
}

function normaliseChoice(choice = {}) {
  return {
    id: choice.id ?? newId('choice'),
    label: choice.label ?? '',
    nextSceneId: choice.nextSceneId ?? null,
    cueCardText: choice.cueCardText ?? '',
  };
}

export function createScene(options = {}) {
  const {
    id = newId('scene'),
    type = SceneType.INTERMEDIATE,
    image = null,
    backgroundAudio = null,
    dialogue = [],
    choices = [],
    autoNextSceneId = null,
    notes = '',
  } = options;

  const normalisedDialogue = dialogue.length
    ? dialogue.slice(0, MAX_DIALOGUE_LINES).map(normaliseDialogueLine)
    : [normaliseDialogueLine()];

  return {
    id,
    type,
    image: image
      ? {
        name: image.name ?? '',
        objectUrl: image.objectUrl ?? null,
        blob: image.blob ?? null,
      }
      : null,
    backgroundAudio: backgroundAudio
      ? {
        name: backgroundAudio.name ?? '',
        objectUrl: backgroundAudio.objectUrl ?? null,
        blob: backgroundAudio.blob ?? null,
      }
      : null,
    dialogue: normalisedDialogue,
    choices: choices.slice(0, 3).map(normaliseChoice),
    autoNextSceneId: type === SceneType.END ? null : (autoNextSceneId ?? null),
    notes,
  };
}

export function canAddDialogueLine(dialogue = []) {
  return dialogue.length < MAX_DIALOGUE_LINES;
}

export function createChoice(options = {}) {
  return normaliseChoice(options);
}

export function createProject(options = {}) {
  const meta = {
    title: options.meta?.title ?? 'Untitled Role Play',
    version: options.meta?.version ?? 1,
  };

  const scenes = options.scenes?.length
    ? options.scenes.map(scene => createScene(scene))
    : [createScene({ type: SceneType.START })];

  return {
    meta,
    scenes,
    assets: Array.isArray(options.assets) ? options.assets.slice() : [],
  };
}
