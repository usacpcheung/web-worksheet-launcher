export const ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH = 200;

export const ROLEPLAYSCENE_T2A_PRESETS = Object.freeze([
  ['cantonese_narrator_female', 'professionalFemale', 'professional-female'],
  ['cantonese_male_1', 'playfulMan', 'playful-man'],
  ['cantonese_male_2', 'playfulManHighPitch', 'playful-man-pitch-3'],
  ['cantonese_male_3', 'male3', 'male-3'],
  ['cantonese_female_1', 'cuteGirl', 'cute-girl'],
  ['cantonese_female_2', 'gentleLady', 'gentle-lady'],
  ['cantonese_female_3', 'female3', 'female-3'],
].map(([id, label, slug]) => Object.freeze({
  id, labelKey: 'inspector.dialogue.t2aPreset.' + label, slug,
  options: Object.freeze({ voice_choice: id }),
})));

const legacyIds = Object.freeze({ default_professional_female: 'cantonese_narrator_female', cantonese_playful_man: 'cantonese_male_1', cantonese_playful_man_pitch_3: 'cantonese_male_2', cantonese_cute_girl: 'cantonese_female_1', cantonese_gentle_lady: 'cantonese_female_2' });
export function getRolePlaySceneT2APresetById(id) {
  const resolved = Object.hasOwn(legacyIds, id) ? legacyIds[id] : id;
  return ROLEPLAYSCENE_T2A_PRESETS.find(preset => preset.id === resolved) || null;
}

export function getAudioVoicePreset(audio) {
  if (!audio) return null;
  return Object.hasOwn(audio, 'generatedVoiceChoice')
    ? getRolePlaySceneT2APresetById(audio.generatedVoiceChoice)
    : getRolePlaySceneT2APresetFromAudioName(audio.name);
}

export function getDialogueVoiceChoice(line, speakers = []) {
  return line.voiceChoice ?? getAudioVoicePreset(line.audio)?.id
    ?? speakers.find(speaker => speaker.id === line.speakerId)?.lastVoiceChoice
    ?? 'cantonese_narrator_female';
}

// Keep unknown strings so the editor can report them instead of silently using a default.
export function voiceChoiceFields(value, key = 'voiceChoice') {
  return value?.[key] == null ? {} : { [key]: String(value[key]) };
}
export function generatedVoiceFields(audio) {
  return audio && Object.hasOwn(audio, 'generatedVoiceChoice')
    ? { generatedVoiceChoice: typeof audio.generatedVoiceChoice === 'string' ? audio.generatedVoiceChoice : null } : {};
}

export function createRolePlaySceneT2AAudioFilename(sceneId, index, presetId) {
  const safeSceneId = String(sceneId || 'scene')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'scene';
  const lineNumber = Math.max(1, Number(index) + 1 || 1);
  const preset = getRolePlaySceneT2APresetById(presetId);
  if (!preset) throw new Error('Invalid voice choice');
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
