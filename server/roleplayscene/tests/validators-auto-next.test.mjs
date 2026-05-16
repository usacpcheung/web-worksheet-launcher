import assert from 'node:assert/strict';
import { validateProject } from '../scripts/editor/validators.js';
import { SceneType } from '../scripts/model.js';

function makeScene(id, type, options = {}) {
  return {
    id,
    type,
    dialogue: options.dialogue ?? [{ text: '' }],
    choices: options.choices ?? [],
    autoNextSceneId: options.autoNextSceneId ?? null,
  };
}

const baseScenes = [
  makeScene('start', SceneType.START, { choices: [], autoNextSceneId: 'next' }),
  makeScene('next', SceneType.INTERMEDIATE, { choices: [], autoNextSceneId: 'end' }),
  makeScene('end', SceneType.END),
];

let result = validateProject({ scenes: baseScenes });
assert.deepEqual(result.errors, [], 'valid auto-next chain should not produce errors');

const reachabilityErrors = validateProject({ scenes: baseScenes }).errors.filter(msg => msg.includes('unreachable'));
assert.strictEqual(reachabilityErrors.length, 0, 'auto-next should contribute to reachability');

const endAutoScenes = [
  makeScene('start', SceneType.START, { choices: [{ id: 'c1', label: 'to-end', nextSceneId: 'end' }] }),
  makeScene('end', SceneType.END, { autoNextSceneId: 'start' }),
];
result = validateProject({ scenes: endAutoScenes });
assert(result.errors.some(msg => msg.includes('End scene "end" cannot auto-advance')), 'end scenes must not auto-advance');

const conflicting = [
  makeScene('start', SceneType.START, { choices: [{ id: 'c1', label: 'forward', nextSceneId: 'mid' }], autoNextSceneId: 'mid' }),
  makeScene('mid', SceneType.INTERMEDIATE, { choices: [], autoNextSceneId: 'end' }),
  makeScene('end', SceneType.END),
];
result = validateProject({ scenes: conflicting });
assert(result.errors.some(msg => msg.includes('cannot have both choices and an auto-advance')), 'scenes cannot mix choices and auto-next');

const missingTarget = [
  makeScene('start', SceneType.START, { autoNextSceneId: 'missing' }),
  makeScene('end', SceneType.END),
];
result = validateProject({ scenes: missingTarget });
assert(result.errors.some(msg => msg.includes('auto-advances to missing scene')), 'auto-next target must exist');

const duplicateAndMissingIds = [
  makeScene('start', SceneType.START, { autoNextSceneId: 'dup' }),
  makeScene('dup', SceneType.INTERMEDIATE, { autoNextSceneId: 'end' }),
  makeScene('dup', SceneType.INTERMEDIATE, { autoNextSceneId: 'end' }),
  makeScene('', SceneType.END),
  makeScene('end', SceneType.END),
];
result = validateProject({ scenes: duplicateAndMissingIds });
assert(result.errors.some(msg => msg.includes('Scene ID "dup" is duplicated')), 'scene IDs must be unique');
assert(result.errors.some(msg => msg.includes('is missing an ID')), 'scene IDs must be non-empty');

console.log('auto-next validator tests passed');
