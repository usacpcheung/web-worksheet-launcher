import assert from 'node:assert/strict';

import { MAX_DIALOGUE_LINES, canAddDialogueLine, createProject, createScene } from '../scripts/model.js';

const sceneWithFourLines = createScene({
  dialogue: [
    { text: 'line 1' },
    { text: 'line 2' },
    { text: 'line 3' },
    { text: 'line 4' },
  ],
});

assert.equal(MAX_DIALOGUE_LINES, 3, 'dialogue max should be set to 3');
assert.equal(sceneWithFourLines.dialogue.length, 3, 'scene dialogue should normalize to max 3 lines');

assert.equal(canAddDialogueLine([{ text: '1' }, { text: '2' }]), true, 'adding the 3rd line should be allowed');
assert.equal(canAddDialogueLine([{ text: '1' }, { text: '2' }, { text: '3' }]), false, 'adding a 4th line should be blocked');

const projectWithSpeaker = createProject({
  speakers: [{ id: 'speaker-0007', name: ' Kelvin ' }],
  scenes: [createScene({ dialogue: [{ text: 'hello', speakerId: 'speaker-0007' }] })],
});
assert.deepEqual(projectWithSpeaker.speakers, [{ id: 'speaker-0007', name: 'Kelvin' }], 'project speakers should normalize');
assert.equal(projectWithSpeaker.scenes[0].dialogue[0].speakerId, 'speaker-0007', 'dialogue speakerId should normalize');

const legacyProject = createProject({ scenes: [createScene({ dialogue: [{ text: 'legacy' }] })] });
assert.deepEqual(legacyProject.speakers, [], 'legacy-style projects should default speakers to an empty array');
assert.equal(legacyProject.scenes[0].dialogue[0].speakerId, null, 'legacy-style dialogue lines should default speakerId to null');

console.log('dialogue limit tests passed');
