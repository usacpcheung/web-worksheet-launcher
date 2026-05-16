export const ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH = 200;

export const ROLEPLAYSCENE_T2A_PRESETS = Object.freeze([
  Object.freeze({
    id: 'default_professional_female',
    labelKey: 'inspector.dialogue.t2aPreset.professionalFemale',
    slug: 'professional-female',
    options: Object.freeze({
      speed: 1.2,
    }),
  }),
  Object.freeze({
    id: 'cantonese_playful_man',
    labelKey: 'inspector.dialogue.t2aPreset.playfulMan',
    slug: 'playful-man',
    options: Object.freeze({
      voice_id: 'Cantonese_PlayfulMan',
      speed: 1.2,
      volume: 1,
      pitch: -1,
    }),
  }),
  Object.freeze({
    id: 'cantonese_playful_man_pitch_3',
    labelKey: 'inspector.dialogue.t2aPreset.playfulManHighPitch',
    slug: 'playful-man-pitch-3',
    options: Object.freeze({
      voice_id: 'Cantonese_PlayfulMan',
      speed: 1.2,
      volume: 1,
      pitch: 3,
    }),
  }),
  Object.freeze({
    id: 'cantonese_cute_girl',
    labelKey: 'inspector.dialogue.t2aPreset.cuteGirl',
    slug: 'cute-girl',
    options: Object.freeze({
      voice_id: 'Cantonese_CuteGirl',
      speed: 1.2,
      volume: 1,
      pitch: 2,
    }),
  }),
  Object.freeze({
    id: 'cantonese_gentle_lady',
    labelKey: 'inspector.dialogue.t2aPreset.gentleLady',
    slug: 'gentle-lady',
    options: Object.freeze({
      voice_id: 'Cantonese_GentleLady',
      speed: 1.2,
      volume: 1,
      pitch: 0,
    }),
  }),
]);

export function getRolePlaySceneT2APresetById(presetId) {
  return ROLEPLAYSCENE_T2A_PRESETS.find((preset) => preset.id === presetId)
    || ROLEPLAYSCENE_T2A_PRESETS[0];
}

export function createRolePlaySceneT2AAudioFilename(sceneId, index, presetId) {
  const safeSceneId = String(sceneId || 'scene')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'scene';
  const lineNumber = Math.max(1, Number(index) + 1 || 1);
  const preset = getRolePlaySceneT2APresetById(presetId);
  return `${safeSceneId}-line-${lineNumber}-t2a-${preset.slug}.mp3`;
}

export function getRolePlaySceneT2APresetFromAudioName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized.endsWith('.mp3')) return null;
  return ROLEPLAYSCENE_T2A_PRESETS.find((preset) => (
    normalized.endsWith(`-t2a-${preset.slug}.mp3`)
  )) || null;
}

export function getRolePlaySceneT2ATextState(text, maxLength = ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH) {
  const trimmedText = String(text ?? '').trim();
  const hasText = trimmedText.length > 0;
  const exceedsLimit = trimmedText.length > maxLength;
  return {
    trimmedText,
    hasText,
    exceedsLimit,
    eligible: hasText && !exceedsLimit,
  };
}
