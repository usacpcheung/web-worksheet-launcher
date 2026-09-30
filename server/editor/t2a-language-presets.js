export const WORKSHEET_T2A_LANGUAGE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'cantonese',
    options: Object.freeze({
      voice_choice: 'cantonese_narrator_female',
    }),
  }),
  Object.freeze({
    id: 'mandarin',
    options: Object.freeze({
      voice_choice: 'mandarin_narrator_female',
    }),
  }),
  Object.freeze({
    id: 'english',
    options: Object.freeze({
      voice_choice: 'english_narrator_female',
    }),
  }),
]);

export function getWorksheetT2ALanguagePresetById(presetId) {
  return WORKSHEET_T2A_LANGUAGE_PRESETS.find((preset) => preset.id === presetId) || null;
}
