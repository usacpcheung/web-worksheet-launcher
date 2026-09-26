// Names are presentation metadata. IDs remain the exact keys used by scene flow.
export const MAX_SCENE_NAME_LENGTH = 80;

// Textareas normalize CRLF and CR when assigning their value.
export function sceneNameInputValue(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

export function getSceneName(scene) {
  return typeof scene?.name === 'string' && scene.name.trim()
    ? scene.name
    : String(scene?.id ?? '');
}

export function getSceneLabel(scene) {
  const name = getSceneName(scene);
  return name === scene.id ? name : `${name} · ${scene.id}`;
}

export function canEditSceneName(value, previousName) {
  return typeof value === 'string'
    && (sceneNameInputValue(value) === sceneNameInputValue(previousName)
      || Array.from(value).length <= MAX_SCENE_NAME_LENGTH);
}

export function fitSceneLabel(text, maxWidth, measure) {
  if (measure(text) <= maxWidth) return text;
  const parts = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment)
    : Array.from(text);
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(`${parts.slice(0, mid).join('')}…`) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${parts.slice(0, low).join('')}…`;
}
