import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKSHEET_T2A_LANGUAGE_PRESETS,
  getWorksheetT2ALanguagePresetById,
} from './t2a-language-presets.js';

test('worksheet T2A language presets keep stable MiniMax voice and language boost pairs', () => {
  assert.deepEqual(WORKSHEET_T2A_LANGUAGE_PRESETS, [
    {
      id: 'cantonese',
      options: {
        voice_id: 'Cantonese_ProfessionalHost（F)',
        language_boost: 'Chinese,Yue',
      },
    },
    {
      id: 'mandarin',
      options: {
        voice_id: 'Chinese (Mandarin)_News_Anchor',
        language_boost: 'Chinese',
      },
    },
    {
      id: 'english',
      options: {
        voice_id: 'English_compelling_lady1',
        language_boost: 'English',
      },
    },
  ]);
});

test('worksheet T2A language presets resolve known ids without defaulting unknown ids', () => {
  assert.equal(getWorksheetT2ALanguagePresetById('mandarin')?.options.language_boost, 'Chinese');
  assert.equal(getWorksheetT2ALanguagePresetById('unknown'), null);
});
