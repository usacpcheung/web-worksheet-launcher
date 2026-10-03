import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKSHEET_T2A_LANGUAGE_PRESETS,
  getWorksheetT2ALanguagePresetById,
} from './t2a-language-presets.js';

test('worksheet T2A language presets use complete bridge narrator choices', () => {
  assert.deepEqual(WORKSHEET_T2A_LANGUAGE_PRESETS, [
    {
      id: 'cantonese',
      options: {
        voice_choice: 'cantonese_narrator_female',
      },
    },
    {
      id: 'mandarin',
      options: {
        voice_choice: 'mandarin_narrator_female',
      },
    },
    {
      id: 'english',
      options: {
        voice_choice: 'english_narrator_female',
      },
    },
  ]);
});

test('worksheet T2A language presets resolve known ids without defaulting unknown ids', () => {
  assert.equal(getWorksheetT2ALanguagePresetById('mandarin')?.options.voice_choice, 'mandarin_narrator_female');
  assert.equal(getWorksheetT2ALanguagePresetById('unknown'), null);
});
