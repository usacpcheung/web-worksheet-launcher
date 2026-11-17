// Value rules shared by the live worksheet and its printable report.
// Keep option order and answer interpretation identical on both surfaces.

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function firstNonBlankString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

export function normalizePromptMediaRefs(mediaRefs) {
  if (!Array.isArray(mediaRefs)) return [];
  return mediaRefs
    .map((ref) => {
      if (!isRecord(ref)) return null;
      if (ref.usage !== 'question_image' && ref.usage !== 'question_audio') return null;
      if (typeof ref.assetId !== 'string' || !ref.assetId.trim()) return null;
      return { usage: ref.usage, assetId: String(ref.assetId) };
    })
    .filter(Boolean);
}

export function coerceAnswerValueByInputType(inputType, rawValue) {
  if (inputType === 'number') {
    if (rawValue === '' || rawValue === null || rawValue === undefined) return '';
    const numeric = Number(rawValue);
    return Number.isFinite(numeric) ? numeric : '';
  }
  if (inputType === 'boolean') {
    if (rawValue === true || rawValue === 'true') return true;
    if (rawValue === false || rawValue === 'false') return false;
    return null;
  }
  return String(rawValue ?? '');
}

// Built-in boolean labels share the editor's existing locale vocabulary.
// Callers pass a normalized boolean; storage and grading keep their raw values.
export function getBooleanAnswerLabel(value, t) {
  return t(`editor.question.booleanValues.${value ? 'true' : 'false'}`);
}

export function deterministicShuffle(items, seedText) {
  const list = [...items];
  const seedSource = String(seedText ?? '');
  let seed = 0;
  for (let i = 0; i < seedSource.length; i += 1) {
    seed = (seed * 31 + seedSource.charCodeAt(i)) >>> 0;
  }
  for (let i = list.length - 1; i > 0; i -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Shared completion rule for navigation and the worksheet answer summary.
export function isAnsweredValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
