const sequences = new Map();

const PAD_WIDTH = new Map([
  ['scene', 3],
]);

export function newId(prefix = 'id') {
  const previous = sequences.get(prefix) ?? 0;
  const next = previous + 1;
  sequences.set(prefix, next);

  const width = PAD_WIDTH.get(prefix) ?? 4;
  const suffix = String(next).padStart(width, '0');
  return `${prefix}-${suffix}`;
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
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

export function seedIdSequence(prefix, maxValue) {
  const safeMax = Number.isFinite(maxValue)
    ? Math.max(0, Math.floor(maxValue))
    : 0;
  sequences.set(prefix, safeMax);
}

export function seedIdSequencesFromProject(project) {
  let maxScene = 0;
  let maxChoice = 0;
  let maxAnchor = 0;
  let maxSpeaker = 0;
  const speakers = Array.isArray(project?.speakers) ? project.speakers : [];
  speakers.forEach((speaker) => {
    const speakerValue = parseIdNumericSuffix(speaker?.id, 'speaker');
    if (speakerValue != null && speakerValue > maxSpeaker) {
      maxSpeaker = speakerValue;
    }
  });
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  scenes.forEach((scene) => {
    const sceneValue = parseIdNumericSuffix(scene?.id, 'scene');
    if (sceneValue != null && sceneValue > maxScene) {
      maxScene = sceneValue;
    }
    const choices = Array.isArray(scene?.choices) ? scene.choices : [];
    choices.forEach((choice) => {
      const choiceValue = parseIdNumericSuffix(choice?.id, 'choice');
      if (choiceValue != null && choiceValue > maxChoice) {
        maxChoice = choiceValue;
      }
    });
    const anchors = Array.isArray(scene?.speechBubble?.anchors) ? scene.speechBubble.anchors : [];
    anchors.forEach((anchor) => {
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
}
