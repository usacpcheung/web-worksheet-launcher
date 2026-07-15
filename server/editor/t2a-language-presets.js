export const WORKSHEET_T2A_LANGUAGE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'cantonese',
    options: Object.freeze({
      voice_id: 'Cantonese_ProfessionalHost（F)',
      language_boost: 'Chinese,Yue',
    }),
  }),
  Object.freeze({
    id: 'mandarin',
    options: Object.freeze({
      voice_id: 'Chinese (Mandarin)_News_Anchor',
      language_boost: 'Chinese',
    }),
  }),
  Object.freeze({
    id: 'english',
    options: Object.freeze({
      voice_id: 'English_compelling_lady1',
      language_boost: 'English',
    }),
  }),
]);

export function getWorksheetT2ALanguagePresetById(presetId) {
  return WORKSHEET_T2A_LANGUAGE_PRESETS.find((preset) => preset.id === presetId) || null;
}
