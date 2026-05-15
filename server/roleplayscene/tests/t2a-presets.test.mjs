import assert from 'node:assert/strict';

import {
  ROLEPLAYSCENE_T2A_PRESETS,
  ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH,
  getRolePlaySceneT2APresetById,
  getRolePlaySceneT2ATextState,
} from '../scripts/t2a-presets.js';

assert.equal(ROLEPLAYSCENE_T2A_TEXT_MAX_LENGTH, 200, 'RolePlayScene T2A should share worksheet text limit');
assert.equal(ROLEPLAYSCENE_T2A_PRESETS.length, 5, 'RolePlayScene should expose five T2A presets');

const [defaultPreset] = ROLEPLAYSCENE_T2A_PRESETS;
assert.equal(defaultPreset.id, 'default_professional_female');
assert.deepEqual(defaultPreset.options, {}, 'default preset should rely on rewrite-bridge voice defaults');

assert.deepEqual(
  getRolePlaySceneT2APresetById('cantonese_playful_man_pitch_2').options,
  {
    voice_id: 'Cantonese_PlayfulMan',
    speed: 1,
    volume: 1,
    pitch: 2,
  },
  'high-pitch playful man should send the requested pitch override',
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

assert.equal(getRolePlaySceneT2ATextState('  hello  ').eligible, true);
assert.equal(getRolePlaySceneT2ATextState('   ').eligible, false);
assert.equal(getRolePlaySceneT2ATextState('x'.repeat(201)).exceedsLimit, true);

console.log('t2a preset tests passed');
