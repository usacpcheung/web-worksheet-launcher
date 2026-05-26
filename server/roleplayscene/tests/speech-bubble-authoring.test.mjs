import assert from 'node:assert/strict';
import test from 'node:test';
import { Blob as NodeBlob } from 'node:buffer';
import { createProject, createScene, SceneType } from '../scripts/model.js';
import {
  createProjectArchive,
  hydrateProject,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  serializeProject,
} from '../scripts/storage.js';
import { zip } from '../scripts/utils/zip.js';
import { validateProject } from '../scripts/editor/validators.js';
import { validateRolePlayScenePackageForPublish } from '../../api/services/roleplayscene-package.js';

if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = NodeBlob;
}

function makeValidBubbleProject(overrides = {}) {
  return createProject({
    meta: { title: 'Bubble Story', version: 1 },
    scenes: [
      createScene({
        id: 'start',
        type: SceneType.START,
        dialogue: [{
          text: 'Hello',
          audio: null,
          bubble: { mode: 'anchor', anchorId: 'anchor-a', x: 0.25, y: 0.4 },
        }],
        speechBubble: {
          enabled: true,
          anchors: [{ id: 'anchor-a', label: 'A', x: 0.25, y: 0.4 }],
        },
        autoNextSceneId: 'end',
        ...overrides.start,
      }),
      createScene({
        id: 'end',
        type: SceneType.END,
        dialogue: [{ text: 'Done', audio: null, bubble: { mode: 'center', anchorId: null } }],
        ...overrides.end,
      }),
    ],
  });
}

test('speech bubble authoring data survives serialize, hydrate, and archive export', async () => {
  const project = makeValidBubbleProject();
  const serialized = serializeProject(project);

  assert.equal(serialized.scenes[0].speechBubble.enabled, true);
  assert.deepEqual(serialized.scenes[0].speechBubble.anchors[0], {
    id: 'anchor-a',
    label: 'A',
    x: 0.25,
    y: 0.4,
  });
  assert.equal(serialized.scenes[0].dialogue[0].bubble.mode, 'anchor');
  assert.equal(serialized.scenes[0].dialogue[0].bubble.anchorId, 'anchor-a');

  const hydrated = hydrateProject(serialized);
  assert.equal(hydrated.scenes[0].speechBubble.enabled, true);
  assert.equal(hydrated.scenes[0].dialogue[0].bubble.anchorId, 'anchor-a');

  const { payload } = await createProjectArchive(hydrated);
  assert.equal(payload.project.scenes[0].speechBubble.enabled, true);
  assert.equal(payload.project.scenes[0].dialogue[0].bubble.mode, 'anchor');
});

test('old packages without speech bubble fields hydrate with safe defaults', () => {
  const legacy = hydrateProject({
    meta: { title: 'Legacy' },
    scenes: [{
      id: 'start',
      type: SceneType.START,
      dialogue: [{ text: 'Legacy line', audio: null }],
      choices: [],
      autoNextSceneId: null,
    }],
  });

  assert.equal(legacy.scenes[0].speechBubble.enabled, false);
  assert.deepEqual(legacy.scenes[0].speechBubble.anchors, []);
  assert.equal(legacy.scenes[0].dialogue[0].bubble.mode, 'center');
});

test('editor validation warns for unused anchors and hidden bubble lines', () => {
  const project = makeValidBubbleProject({
    start: {
      dialogue: [{ text: 'Hidden line', audio: null, bubble: { mode: 'hidden', anchorId: null } }],
      speechBubble: {
        enabled: true,
        anchors: [{ id: 'anchor-a', label: 'A', x: 0.25, y: 0.4 }],
      },
    },
  });
  const result = validateProject(project);

  assert.equal(result.errors.length, 0);
  assert(result.warnings.some(message => message.includes('no visible dialogue lines')));
  assert(result.warnings.some(message => message.includes('not used by any dialogue line')));
  assert(result.warnings.some(message => message.includes('hidden from speech bubble mode')));
});

test('publish validation rejects broken anchor assignments but allows picture-only bubble scenes', async () => {
  const brokenProject = makeValidBubbleProject({
    start: {
      dialogue: [{ text: 'Broken', audio: null, bubble: { mode: 'anchor', anchorId: 'missing' } }],
    },
  });
  const { archiveData: brokenArchive } = await createProjectArchive(brokenProject);
  const brokenValidation = validateRolePlayScenePackageForPublish(brokenArchive);

  assert.equal(brokenValidation.ok, false);
  assert.equal(brokenValidation.error.code, 'INVALID_ROLEPLAYSCENE_PUBLISH_PACKAGE');
  assert(brokenValidation.error.details.errors.some(message => message.includes('missing speech bubble anchor')));

  const pictureOnlyProject = makeValidBubbleProject({
    start: {
      dialogue: [],
      speechBubble: {
        enabled: true,
        anchors: [{ id: 'anchor-a', label: 'A', x: 0.25, y: 0.4 }],
      },
    },
  });
  const { archiveData: pictureOnlyArchive } = await createProjectArchive(pictureOnlyProject);
  const pictureOnlyValidation = validateRolePlayScenePackageForPublish(pictureOnlyArchive);

  assert.equal(pictureOnlyValidation.ok, true);
  assert(pictureOnlyValidation.publishValidation.warnings.some(message => message.includes('no visible dialogue lines')));
});

test('publish validation rejects duplicate anchor ids', async () => {
  const project = makeValidBubbleProject({
    start: {
      speechBubble: {
        enabled: true,
        anchors: [
          { id: 'anchor-a', label: 'A', x: 0.25, y: 0.4 },
          { id: 'anchor-a', label: 'B', x: 2, y: 0.4 },
        ],
      },
    },
  });
  const serialized = serializeProject(project);
  serialized.scenes[0].speechBubble.anchors[1].x = 2;
  const { archiveData } = await createProjectArchive(hydrateProject(serialized));
  const validation = validateRolePlayScenePackageForPublish(archiveData);

  assert.equal(validation.ok, false);
  assert(validation.error.details.errors.some(message => message.includes('duplicated')));
});

test('publish validation rejects out-of-range anchor coordinates from raw packages', async () => {
  const encoder = new TextEncoder();
  const project = {
    meta: { title: 'Raw Bubble Story', version: 1 },
    scenes: [
      {
        id: 'start',
        type: 'start',
        dialogue: [{ text: 'Hello', audio: null, bubble: { mode: 'anchor', anchorId: 'anchor-a' } }],
        speechBubble: {
          enabled: true,
          anchors: [{ id: 'anchor-a', label: 'A', x: 1.2, y: 0.4 }],
        },
        choices: [],
        autoNextSceneId: 'end',
      },
      {
        id: 'end',
        type: 'end',
        dialogue: [{ text: 'Done', audio: null }],
        choices: [],
        autoNextSceneId: null,
      },
    ],
  };
  const archive = await zip({
    'manifest.json': encoder.encode(JSON.stringify({
      format: PACKAGE_FORMAT,
      packageVersion: PACKAGE_VERSION,
      project: { title: project.meta.title, version: 1 },
      assets: [],
    })),
    'content/project.json': encoder.encode(JSON.stringify(project)),
  });
  const validation = validateRolePlayScenePackageForPublish(archive);

  assert.equal(validation.ok, false);
  assert(validation.error.details.errors.some(message => message.includes('invalid coordinates')));
});
