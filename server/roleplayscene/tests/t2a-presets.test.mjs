import assert from 'node:assert/strict';

import {
  ROLEPLAYSCENE_T2A_PRESETS,
  ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH,
  createRolePlaySceneT2AAudioFilename,
  getRolePlaySceneT2APresetById,
  getRolePlaySceneT2APresetFromAudioName,
  getRolePlaySceneT2ATextState,
} from '../scripts/t2a-presets.js';

assert.equal(ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH, 200, 'RolePlayScene T2A should share worksheet text limit');
assert.equal(ROLEPLAYSCENE_T2A_PRESETS.length, 5, 'RolePlayScene should expose five T2A presets');

const [defaultPreset] = ROLEPLAYSCENE_T2A_PRESETS;
assert.equal(defaultPreset.id, 'default_professional_female');
assert.deepEqual(defaultPreset.options, {}, 'default preset should rely on rewrite-bridge voice defaults');

assert.deepEqual(
  getRolePlaySceneT2APresetById('cantonese_playful_man').options,
  {
    voice_id: 'Cantonese_PlayfulMan',
    speed: 1,
    volume: 1,
    pitch: -2,
  },
  'playful man should send the requested lower pitch override',
);

assert.deepEqual(
  getRolePlaySceneT2APresetById('cantonese_playful_man_pitch_3').options,
  {
    voice_id: 'Cantonese_PlayfulMan',
    speed: 1,
    volume: 1,
    pitch: 3,
  },
  'high-pitch playful man should send the requested pitch override',
);

assert.deepEqual(
  getRolePlaySceneT2APresetById('cantonese_cute_girl').options,
  {
    voice_id: 'Cantonese_CuteGirl',
    speed: 1,
    volume: 1,
    pitch: 2,
  },
  'cute girl should send the requested pitch override',
);

assert.deepEqual(
  getRolePlaySceneT2APresetById('cantonese_gentle_lady').options,
  {
    voice_id: 'Cantonese_GentleLady',
    speed: 1,
    volume: 1,
    pitch: 0,
  },
  'gentle lady should use the MiniMax Cantonese voice id',
);

assert.equal(
  createRolePlaySceneT2AAudioFilename('scene 3', 1, 'cantonese_playful_man_pitch_3'),
  'scene-3-line-2-t2a-playful-man-pitch-3.mp3',
  'generated T2A filenames should include scene, line, and preset slug',
);
assert.equal(
  getRolePlaySceneT2APresetFromAudioName('scene-3-line-2-t2a-playful-man-pitch-3.mp3')?.id,
  'cantonese_playful_man_pitch_3',
  'generated filenames should resolve back to a preset for best-effort badges',
);
assert.equal(
  getRolePlaySceneT2APresetFromAudioName('manual-upload.mp3'),
  null,
  'manual filenames should not resolve to T2A preset badges',
);

assert.equal(getRolePlaySceneT2ATextState('  hello  ').eligible, true);
assert.equal(getRolePlaySceneT2ATextState('   ').eligible, false);
assert.equal(getRolePlaySceneT2ATextState('x'.repeat(201)).exceedsLimit, true);

console.log('t2a preset tests passed');
