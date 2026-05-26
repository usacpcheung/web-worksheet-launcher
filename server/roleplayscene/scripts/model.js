// Schema helpers and factories
import { newId } from './utils/id.js';

export const SceneType = Object.freeze({
  START: 'start',
  INTERMEDIATE: 'intermediate',
  END: 'end',
});

export const MAX_DIALOGUE_LINES = 3;
export const MAX_SPEECH_BUBBLE_ANCHORS = 4;

export const BubbleMode = Object.freeze({
  ANCHOR: 'anchor',
  CENTER: 'center',
  HIDDEN: 'hidden',
});

const ANCHOR_LABELS = ['A', 'B', 'C', 'D'];

function normaliseCoordinate(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function normaliseSpeechBubbleAnchor(anchor = {}, index = 0) {
  return {
    id: String(anchor.id ?? newId('anchor')),
    label: String(anchor.label ?? ANCHOR_LABELS[index] ?? String(index + 1)),
    x: normaliseCoordinate(anchor.x),
    y: normaliseCoordinate(anchor.y),
  };
}

function normaliseLineBubble(bubble = {}) {
  const mode = Object.values(BubbleMode).includes(bubble.mode)
    ? bubble.mode
    : BubbleMode.CENTER;
  const result = {
    mode,
    anchorId: mode === BubbleMode.ANCHOR && bubble.anchorId != null ? String(bubble.anchorId) : null,
  };
  if (bubble.x !== undefined) result.x = normaliseCoordinate(bubble.x);
  if (bubble.y !== undefined) result.y = normaliseCoordinate(bubble.y);
  return result;
}

function normaliseSpeechBubble(value = {}) {
  const anchors = Array.isArray(value.anchors)
    ? value.anchors.slice(0, MAX_SPEECH_BUBBLE_ANCHORS).map(normaliseSpeechBubbleAnchor)
    : [];
  return {
    enabled: value.enabled === true,
    anchors,
  };
}

function normaliseSpeaker(speaker = {}) {
  return {
    id: String(speaker.id ?? newId('speaker')),
    name: String(speaker.name ?? '').trim(),
  };
}

function normaliseDialogueLine(line = {}) {
  return {
    text: line.text ?? '',
    speakerId: line.speakerId == null || line.speakerId === '' ? null : String(line.speakerId),
    audio: line.audio
      ? {
        name: line.audio.name ?? '',
        objectUrl: line.audio.objectUrl ?? null,
        blob: line.audio.blob ?? null,
      }
      : null,
    bubble: normaliseLineBubble(line.bubble),
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
    speechBubble = {},
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
    speechBubble: normaliseSpeechBubble(speechBubble),
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
    speakers: Array.isArray(options.speakers) ? options.speakers.map(normaliseSpeaker).filter(speaker => speaker.name) : [],
    scenes,
    assets: Array.isArray(options.assets) ? options.assets.slice() : [],
  };
}
