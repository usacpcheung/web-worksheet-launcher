import { MAX_DIALOGUE_LINES, MAX_SPEECH_BUBBLE_ANCHORS } from './model.js';
import { validateSceneIdentity } from './scene-identity.js';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Check before editor normalization or publishing. Drafts may still have
// empty dialogue, missing media and choices without destinations.
export function sceneImportErrors(project) {
  if (!Array.isArray(project?.scenes)) return ['Project scenes are missing.'];
  if (project.scenes.length > 20) return ['Project must have at most 20 scenes.'];
  const errors = validateSceneIdentity(project);
  for (const [i, scene] of project.scenes.entries()) {
    for (const [field, items, limit] of [
      ['dialogue', scene?.dialogue, MAX_DIALOGUE_LINES],
      ['choices', scene?.choices, 3],
      ['speechBubble.anchors', scene?.speechBubble?.anchors, MAX_SPEECH_BUBBLE_ANCHORS],
    ]) {
      if (items == null) continue;
      const path = `scenes[${i}].${field}`;
      if (!Array.isArray(items)) errors.push(`${path} must be an array.`);
      else if (items.length > limit) errors.push(`${path} must contain at most ${limit} items.`);
      else items.forEach((item, index) => {
        if (!isRecord(item)) errors.push(`${path}[${index}] must be an object.`);
        else if (field === 'dialogue' && item.text != null && typeof item.text !== 'string') {
          errors.push(`${path}[${index}] must be an object with string text.`);
        }
      });
    }
  }
  return errors;
}
