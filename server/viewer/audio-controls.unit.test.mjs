import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewerAudioSources } from './audio-controls.js';

test('resolveViewerAudioSources prefers canonical multilingual tracks and falls back to legacy audio', async () => {
  const legacy = { usage: 'question_audio', assetId: 'legacy_audio' };

  assert.deepEqual(resolveViewerAudioSources([], null), []);
  assert.deepEqual(resolveViewerAudioSources([], legacy), [
    { assetId: 'legacy_audio', language: null, legacy: true },
  ]);
  assert.deepEqual(resolveViewerAudioSources([
    { language: 'english', assetId: 'audio_en', voicePresetId: 'english', sourceTextHash: 'h_en' },
    { language: 'cantonese', assetId: 'audio_yue', voicePresetId: null, sourceTextHash: 'h_yue' },
  ], legacy), [
    { assetId: 'audio_yue', language: 'cantonese', legacy: false },
    { assetId: 'audio_en', language: 'english', legacy: false },
  ]);
});

test('invalid canonical tracks retain legacy playback without changing the package', () => {
  const tracks = [{ language: 'english', assetId: 'bad', sourceTextHash: '' }];
  const legacy = { usage: 'option_audio', assetId: 'legacy-option' };
  const before = structuredClone({ tracks, legacy });
  assert.deepEqual(resolveViewerAudioSources(tracks, legacy), [
    { assetId: 'legacy-option', language: null, legacy: true },
  ]);
  assert.deepEqual({ tracks, legacy }, before);
});
