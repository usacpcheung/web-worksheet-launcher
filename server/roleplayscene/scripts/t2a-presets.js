export const ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH = 200;

export const ROLEPLAYSCENE_T2A_PRESETS = Object.freeze([
  Object.freeze({
    id: 'default_professional_female',
    labelKey: 'inspector.dialogue.t2aPreset.professionalFemale',
    options: Object.freeze({}),
  }),
  Object.freeze({
    id: 'cantonese_playful_man',
    labelKey: 'inspector.dialogue.t2aPreset.playfulMan',
    options: Object.freeze({
      voice_id: 'Cantonese_PlayfulMan',
      speed: 1,
      volume: 1,
      pitch: -2,
    }),
  }),
  Object.freeze({
    id: 'cantonese_playful_man_pitch_3',
    labelKey: 'inspector.dialogue.t2aPreset.playfulManHighPitch',
    options: Object.freeze({
      voice_id: 'Cantonese_PlayfulMan',
      speed: 1,
      volume: 1,
      pitch: 3,
    }),
  }),
  Object.freeze({
    id: 'cantonese_cute_girl',
    labelKey: 'inspector.dialogue.t2aPreset.cuteGirl',
    options: Object.freeze({
      voice_id: 'Cantonese_CuteGirl',
      speed: 1,
      volume: 1,
      pitch: 2,
    }),
  }),
  Object.freeze({
    id: 'cantonese_gentle_lady',
    labelKey: 'inspector.dialogue.t2aPreset.gentleLady',
    options: Object.freeze({
      voice_id: 'Cantonese_GentleLady',
      speed: 1,
      volume: 1,
      pitch: 0,
    }),
  }),
]);

export function getRolePlaySceneT2APresetById(presetId) {
  return ROLEPLAYSCENE_T2A_PRESETS.find((preset) => preset.id === presetId)
    || ROLEPLAYSCENE_T2A_PRESETS[0];
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
