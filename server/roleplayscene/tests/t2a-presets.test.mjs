import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLEPLAYSCENE_T2A_PRESETS, getRolePlaySceneT2APresetById, getRolePlaySceneT2APresetFromAudioName, getDialogueVoiceChoice, getAudioVoicePreset, createRolePlaySceneT2AAudioFilename, getRolePlaySceneT2ATextState } from '../scripts/t2a-presets.js';
import { createProject } from '../scripts/model.js';
import { serializeProject, hydrateProject, createProjectArchive, extractProjectFromArchive } from '../scripts/storage.js';
import { validateRolePlayScenePackage } from '../../api/services/roleplayscene-package.js';
test('seven complete choices and old filenames resolve without guessing invalid choices', () => {
 assert.equal(ROLEPLAYSCENE_T2A_PRESETS.length, 7);
 for (const preset of ROLEPLAYSCENE_T2A_PRESETS) {
  assert.deepEqual(preset.options, { voice_choice: preset.id });
  assert.equal(getRolePlaySceneT2APresetFromAudioName(createRolePlaySceneT2AAudioFilename('s', 0, preset.id)), preset);
 }
 assert.equal(getRolePlaySceneT2APresetById('unknown'), null);
 assert.equal(getRolePlaySceneT2APresetFromAudioName('s-t2a-playful-man-pitch-3.mp3').id, 'cantonese_male_2');
 assert.equal(getAudioVoicePreset({ name: 'recording.mp3' }), null);
 assert.equal(getAudioVoicePreset({ name: 's-t2a-cute-girl.mp3', generatedVoiceChoice: null }), null);
 assert.equal(getRolePlaySceneT2ATextState(' ').eligible, false);
 assert.equal(getRolePlaySceneT2ATextState('x'.repeat(201)).exceedsLimit, true);
});
test('line, speaker and generated voice metadata survive snapshot and ZIP with audio bytes', async () => {
 const project = createProject({ speakers: [{ id: 'a', name: 'Alex', lastVoiceChoice: 'cantonese_male_3' }], scenes: [{ id: 's', type: 'start', dialogue: [
  { text: 'Hello', speakerId: 'a', voiceChoice: 'cantonese_female_3', audio: { name: 'line.mp3', blob: new Blob([new Uint8Array([1,2,3])], {type:'audio/mpeg'}), generatedVoiceChoice: 'cantonese_male_1' } },
  { text: 'Later', speakerId: 'a' }
 ] }] });
 const archive = (await createProjectArchive(project)).archiveData;
 const accepted = validateRolePlayScenePackage(archive);
 assert.equal(accepted.ok, true);
 assert.equal(accepted.project.speakers[0].lastVoiceChoice, 'cantonese_male_3');
 assert.equal(accepted.project.scenes[0].dialogue[0].audio.generatedVoiceChoice, 'cantonese_male_1');
 for (const restored of [hydrateProject(serializeProject(project)), hydrateProject(await extractProjectFromArchive(archive))]) {
  const [first, second] = restored.scenes[0].dialogue;
  assert.equal(getDialogueVoiceChoice(first, restored.speakers), 'cantonese_female_3');
  assert.equal(getAudioVoicePreset(first.audio).id, 'cantonese_male_1');
  assert.deepEqual(new Uint8Array(await first.audio.blob.arrayBuffer()), new Uint8Array([1,2,3]));
  assert.equal(getDialogueVoiceChoice(second, restored.speakers), 'cantonese_male_3');
  assert.equal(second.voiceChoice, undefined);
 }
});
test('old packages retain known line voices without inventing speaker preferences', () => {
 const p = createProject({ speakers: [{id:'a',name:'A'}], scenes: [{dialogue:[
  {text:'Old',speakerId:'a',audio:{name:'s-t2a-gentle-lady.mp3'}},
  {text:'Custom',audio:{name:'recording.mp3'}}, {text:'Future',voiceChoice:'unknown'}
 ]}] });
 assert.equal(p.scenes[0].dialogue[0].voiceChoice,'cantonese_female_2');
 assert.equal(p.speakers[0].lastVoiceChoice,undefined);
 assert.equal(p.scenes[0].dialogue[1].voiceChoice,undefined);
 assert.equal(getDialogueVoiceChoice(p.scenes[0].dialogue[2]),'unknown');
});
