import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAudioTracks } from './audio-tracks.js';

test('normalizeAudioTracks keeps valid tracks in canonical language order', () => {
  const tracks = normalizeAudioTracks([
    { language: 'english', assetId: 'audio-en', voicePresetId: null, sourceTextHash: 'hash-en' },
    { language: 'mandarin', assetId: 'audio-zh', voicePresetId: 'mandarin', sourceTextHash: 'hash-zh' },
    { language: 'cantonese', assetId: 'audio-yue', voicePresetId: 'cantonese', sourceTextHash: 'hash-yue' },
  ]);

  assert.deepEqual(tracks.map((track) => track.language), ['cantonese', 'mandarin', 'english']);
});

test('normalizeAudioTracks drops malformed and duplicate-language tracks', () => {
  const tracks = normalizeAudioTracks([
    { language: 'english', assetId: 'audio-en', voicePresetId: null, sourceTextHash: 'hash-1' },
    { language: 'english', assetId: 'audio-en-2', voicePresetId: null, sourceTextHash: 'hash-2' },
    { language: 'mandarin', assetId: 'audio-zh', voicePresetId: 'english', sourceTextHash: 'hash-3' },
    { language: 'french', assetId: 'audio-fr', voicePresetId: null, sourceTextHash: 'hash-4' },
    { language: 'cantonese', assetId: '', voicePresetId: null, sourceTextHash: 'hash-5' },
  ]);

  assert.deepEqual(tracks, [
    { language: 'english', assetId: 'audio-en', voicePresetId: null, sourceTextHash: 'hash-1' },
  ]);
});
