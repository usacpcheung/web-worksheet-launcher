import assert from 'node:assert/strict';
import { validateProject } from '../scripts/editor/validators.js';
import { createProject, createScene, createChoice, SceneType } from '../scripts/model.js';

function logResult(label, condition) {
  assert.ok(condition, label);
  console.log(`OK: ${label}`);
}

const endScene = createScene({ type: SceneType.END, id: 'end-scene' });
const startScene = createScene({
  type: SceneType.START,
  id: 'start-scene',
  choices: [createChoice({ label: 'Finish', nextSceneId: 'end-scene' })],
});
const validProject = createProject({ scenes: [startScene, endScene] });
const validResult = validateProject(validProject);
logResult('Play allowed when validation passes', validResult.errors.length === 0);

const noEndProject = createProject({
  scenes: [createScene({ type: SceneType.START })],
});
const noEndResult = validateProject(noEndProject);
logResult('Missing end scene blocks Play mode', noEndResult.errors.some(msg => msg.includes('at least 1 end scene')));

const multiStartProject = createProject({
  scenes: [
    createScene({ type: SceneType.START }),
    createScene({ type: SceneType.START }),
  ],
});
const multiStartResult = validateProject(multiStartProject);
logResult('Multiple start scenes block Play mode', multiStartResult.errors.length > 0);

const brokenLinkProject = createProject({
  scenes: [
    createScene({ type: SceneType.START }),
    createScene({ type: SceneType.INTERMEDIATE }),
  ],
});
brokenLinkProject.scenes[0].choices = [
  createChoice({ label: 'Broken', nextSceneId: 'missing-scene' }),
];
const brokenLinkResult = validateProject(brokenLinkProject);
logResult('Broken links block Play mode', brokenLinkResult.errors.some(msg => msg.includes('missing scene')));
