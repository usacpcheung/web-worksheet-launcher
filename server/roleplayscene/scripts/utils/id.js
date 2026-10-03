const sequences = new Map();
const reservedIds = new Map();

const PAD_WIDTH = new Map([
  ['scene', 3],
]);

export function newId(prefix = 'id') {
  const width = PAD_WIDTH.get(prefix) ?? 4;
  const used = reservedIds.get(prefix) ?? new Set();
  let next = sequences.get(prefix) ?? 0;
  let id;
  do {
    next = next >= Number.MAX_SAFE_INTEGER ? 1 : next + 1;
    id = prefix + '-' + String(next).padStart(width, '0');
  } while (used.has(id));
  sequences.set(prefix, next);
  used.add(id);
  reservedIds.set(prefix, used);
  return id;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseIdNumericSuffix(id, prefix) {
  if (typeof id !== 'string' || !prefix) {
    return null;
  }
  const escapedPrefix = escapeRegex(prefix);
  const canonicalPattern = new RegExp(`^${escapedPrefix}-(\\d+)$`);
  const legacyPattern = new RegExp(`^${escapedPrefix}(\\d+)$`);
  const canonicalMatch = id.match(canonicalPattern);
  const legacyMatch = canonicalMatch ? null : id.match(legacyPattern);
  const suffix = canonicalMatch?.[1] ?? legacyMatch?.[1] ?? null;
  if (!suffix) {
    return null;
  }
  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

export function seedIdSequence(prefix, maxValue) {
  const safeMax = Number.isSafeInteger(Math.floor(maxValue))
    ? Math.max(0, Math.floor(maxValue))
    : 0;
  sequences.set(prefix, safeMax);
}

export function seedIdSequencesFromProject(project) {
  reservedIds.clear();
  const reserve = (prefix, id) => {
    if (typeof id !== 'string') return;
    if (!reservedIds.has(prefix)) reservedIds.set(prefix, new Set());
    reservedIds.get(prefix).add(id);
  };
  let maxScene = 0;
  let maxChoice = 0;
  let maxAnchor = 0;
  let maxSpeaker = 0;
  const speakers = Array.isArray(project?.speakers) ? project.speakers : [];
  speakers.forEach((speaker) => {
    reserve('speaker', speaker?.id);
    const speakerValue = parseIdNumericSuffix(speaker?.id, 'speaker');
    if (speakerValue != null && speakerValue > maxSpeaker) {
      maxSpeaker = speakerValue;
    }
  });
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  scenes.forEach((scene) => {
    reserve('scene', scene?.id);
    const sceneValue = parseIdNumericSuffix(scene?.id, 'scene');
    if (sceneValue != null && sceneValue > maxScene) {
      maxScene = sceneValue;
    }
    const choices = Array.isArray(scene?.choices) ? scene.choices : [];
    choices.forEach((choice) => {
      reserve('choice', choice?.id);
      const choiceValue = parseIdNumericSuffix(choice?.id, 'choice');
      if (choiceValue != null && choiceValue > maxChoice) {
        maxChoice = choiceValue;
      }
    });
    const anchors = Array.isArray(scene?.speechBubble?.anchors) ? scene.speechBubble.anchors : [];
    anchors.forEach((anchor) => {
      reserve('anchor', anchor?.id);
      const anchorValue = parseIdNumericSuffix(anchor?.id, 'anchor');
      if (anchorValue != null && anchorValue > maxAnchor) {
        maxAnchor = anchorValue;
      }
    });
  });

  seedIdSequence('scene', maxScene);
  seedIdSequence('choice', maxChoice);
  seedIdSequence('anchor', maxAnchor);
  seedIdSequence('speaker', maxSpeaker);
}

export function resetIdSequences() {
  sequences.clear();
  reservedIds.clear();
}
