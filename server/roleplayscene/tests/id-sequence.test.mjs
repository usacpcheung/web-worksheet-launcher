import assert from 'node:assert/strict';
import {
  newId,
  resetIdSequences,
  parseIdNumericSuffix,
  seedIdSequence,
  seedIdSequencesFromProject,
} from '../scripts/utils/id.js';
import { createProject, createScene } from '../scripts/model.js';

resetIdSequences();

const firstSceneId = newId('scene');
const firstChoiceId = newId('choice');
const secondSceneId = newId('scene');

assert.equal(firstSceneId, 'scene-001');
assert.equal(firstChoiceId, 'choice-0001');
assert.equal(secondSceneId, 'scene-002');

resetIdSequences();

assert.equal(parseIdNumericSuffix('scene-001', 'scene'), 1);
assert.equal(parseIdNumericSuffix('choice-0007', 'choice'), 7);
assert.equal(parseIdNumericSuffix('scene01', 'scene'), 1, 'legacy IDs should be parsed');
assert.equal(parseIdNumericSuffix('scene-nope', 'scene'), null, 'invalid IDs should be ignored');

seedIdSequence('scene', 2);
assert.equal(newId('scene'), 'scene-003', 'seedIdSequence should set next generated ID');

resetIdSequences();
seedIdSequencesFromProject({
  scenes: [
    {
      id: 'scene-001',
      speechBubble: {
        anchors: [{ id: 'anchor-0003' }],
      },
      choices: [
        { id: 'choice-0002' },
        { id: 'choice-0007' },
      ],
    },
    {
      id: 'scene-002',
      speechBubble: {
        anchors: [{ id: 'anchor-0005' }],
      },
      choices: [
        { id: 'choice3' },
      ],
    },
  ],
});

assert.equal(newId('scene'), 'scene-003', 'hydrated scene IDs should reseed scene counter');
assert.equal(newId('choice'), 'choice-0008', 'hydrated choice IDs should reseed choice counter');
assert.equal(newId('anchor'), 'anchor-0006', 'hydrated speech bubble anchors should reseed anchor counter');

resetIdSequences();
seedIdSequencesFromProject({
  scenes: [{ id: 'scene01', choices: [{ id: 'choice0009' }] }],
});
assert.equal(newId('scene'), 'scene-002', 'legacy scene IDs should reseed scene counter');
assert.equal(newId('choice'), 'choice-0010', 'legacy choice IDs should reseed choice counter');

resetIdSequences();

seedIdSequencesFromProject({
  scenes: [{ id: 'scene-099' }],
});
assert.equal(newId('scene'), 'scene-100', 'imported stories should continue after their highest scene ID');

resetIdSequences();
const freshStory = createProject();
assert.equal(freshStory.scenes[0].id, 'scene-001', 'a fresh story should restart its scene ID sequence');
assert.equal(createScene().id, 'scene-002', 'new scenes in the fresh story should retain sequential IDs');

resetIdSequences();

console.log('id sequence tests passed');
