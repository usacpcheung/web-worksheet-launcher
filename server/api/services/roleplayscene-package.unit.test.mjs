import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRolePlaySceneDraftArtifactStoreInput,
  getRolePlaySceneDraftArtifactBucket,
  ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET,
  ROLEPLAYSCENE_PACKAGE_FORMAT,
  ROLEPLAYSCENE_PACKAGE_VERSION,
  validateRolePlayScenePackage,
} from './roleplayscene-package.js';
import { createStoredZip } from '../../editor/zip-utils.js';
import { zipSync } from '../../roleplayscene/scripts/vendor/fflate.module.js';

function createProject(overrides = {}) {
  return {
    meta: { title: 'Clinic Practice', description: 'Draft conversation practice.' },
    scenes: [
      {
        id: 'scene-start',
        type: 'start',
        image: { name: 'cover.png', type: 'image/png', size: 5, path: 'media/scene-start/image.png' },
        backgroundAudio: null,
        dialogue: [
          {
            text: 'Hello',
            audio: { name: 'line.mp3', type: 'audio/mpeg', size: 5, path: 'media/scene-start/dialogue-1.mp3' },
          },
        ],
        choices: [{ id: 'choice-1', label: 'Continue', nextSceneId: null, cueCardText: '' }],
        autoNextSceneId: null,
        notes: '',
      },
    ],
    assets: [],
    ...overrides,
  };
}

function createManifest(overrides = {}) {
  return {
    format: ROLEPLAYSCENE_PACKAGE_FORMAT,
    packageVersion: ROLEPLAYSCENE_PACKAGE_VERSION,
    createdAt: '2026-05-12T00:00:00.000Z',
    project: { title: 'Clinic Practice', version: 1 },
    assets: [
      {
        path: 'media/scene-start/image.png',
        kind: 'image',
        usage: 'scene_image',
        byteLength: 5,
      },
      {
        path: 'media/scene-start/dialogue-1.mp3',
        kind: 'audio',
        usage: 'dialogue_audio',
        byteLength: 5,
      },
    ],
    ...overrides,
  };
}

function createPackageZip({
  manifest = createManifest(),
  project = createProject(),
  includeManifest = true,
  includeProject = true,
  mediaEntries = {
    'media/scene-start/image.png': 'image',
    'media/scene-start/dialogue-1.mp3': 'audio',
  },
  extraEntries = {},
} = {}) {
  const entries = [];
  if (includeManifest) {
    entries.push({ path: 'manifest.json', data: JSON.stringify(manifest) });
  }
  if (includeProject) {
    entries.push({ path: 'content/project.json', data: JSON.stringify(project) });
  }
  for (const [path, data] of Object.entries(mediaEntries)) {
    entries.push({ path, data });
  }
  for (const [path, data] of Object.entries(extraEntries)) {
    entries.push({ path, data });
  }
  return createStoredZip(entries);
}

function createCompressedPackageZip({
  manifest = createManifest(),
  project = createProject(),
  mediaEntries = {
    'media/scene-start/image.png': 'image',
    'media/scene-start/dialogue-1.mp3': 'audio',
  },
} = {}) {
  const encoder = new TextEncoder();
  const entries = {
    'manifest.json': encoder.encode(JSON.stringify(manifest)),
    'content/project.json': encoder.encode(JSON.stringify(project)),
  };
  for (const [path, data] of Object.entries(mediaEntries)) {
    entries[path] = encoder.encode(data);
  }
  return zipSync(entries);
}

test('validateRolePlayScenePackage accepts valid v2 packages and returns metadata', () => {
  const result = validateRolePlayScenePackage(createPackageZip());

  assert.equal(result.ok, true);
  assert.equal(result.metadata.title, 'Clinic Practice');
  assert.equal(result.metadata.description, 'Draft conversation practice.');
  assert.equal(result.metadata.packageVersion, 1);
  assert.equal(result.metadata.sceneCount, 1);
  assert.equal(result.metadata.mediaCount, 2);
  assert.equal(result.metadata.missingMediaCount, 0);
  assert.equal(result.metadata.validationWarningCount, 0);
  assert.deepEqual(result.warnings, []);
});

test('validateRolePlayScenePackage accepts fflate-compressed RolePlayScene exports', () => {
  const result = validateRolePlayScenePackage(createCompressedPackageZip());

  assert.equal(result.ok, true);
  assert.equal(result.metadata.title, 'Clinic Practice');
  assert.equal(result.metadata.sceneCount, 1);
  assert.equal(result.metadata.mediaCount, 2);
});

test('validateRolePlayScenePackage rejects legacy RolePlayScene ZIPs', () => {
  const legacyZip = createStoredZip([
    {
      path: 'project.json',
      data: JSON.stringify(createProject()),
    },
  ]);

  const result = validateRolePlayScenePackage(legacyZip);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROLEPLAYSCENE_PACKAGE_MISSING_MANIFEST');
});

test('validateRolePlayScenePackage rejects missing required package files', () => {
  const missingManifest = validateRolePlayScenePackage(createPackageZip({ includeManifest: false }));
  assert.equal(missingManifest.ok, false);
  assert.equal(missingManifest.error.code, 'ROLEPLAYSCENE_PACKAGE_MISSING_MANIFEST');

  const missingProject = validateRolePlayScenePackage(createPackageZip({ includeProject: false }));
  assert.equal(missingProject.ok, false);
  assert.equal(missingProject.error.code, 'ROLEPLAYSCENE_PACKAGE_MISSING_PROJECT');
});

test('validateRolePlayScenePackage rejects unsupported format and version', () => {
  const unsupportedFormat = validateRolePlayScenePackage(createPackageZip({
    manifest: createManifest({ format: 'worksheet-package' }),
  }));
  assert.equal(unsupportedFormat.ok, false);
  assert.equal(unsupportedFormat.error.code, 'UNSUPPORTED_ROLEPLAYSCENE_PACKAGE_FORMAT');

  const unsupportedVersion = validateRolePlayScenePackage(createPackageZip({
    manifest: createManifest({ packageVersion: 2 }),
  }));
  assert.equal(unsupportedVersion.ok, false);
  assert.equal(unsupportedVersion.error.code, 'UNSUPPORTED_ROLEPLAYSCENE_PACKAGE_VERSION');
});

test('validateRolePlayScenePackage rejects invalid project JSON and scene shape', () => {
  const invalidProjectJson = validateRolePlayScenePackage(createStoredZip([
    { path: 'manifest.json', data: JSON.stringify(createManifest()) },
    { path: 'content/project.json', data: '{not json' },
  ]));
  assert.equal(invalidProjectJson.ok, false);
  assert.equal(invalidProjectJson.error.code, 'INVALID_ROLEPLAYSCENE_PROJECT_JSON');
  assert.equal(invalidProjectJson.error.details.reason, 'RolePlayScene package content/project.json is malformed.');

  const missingScenes = validateRolePlayScenePackage(createPackageZip({ project: { meta: { title: 'No Scenes' } } }));
  assert.equal(missingScenes.ok, false);
  assert.equal(missingScenes.error.code, 'INVALID_ROLEPLAYSCENE_PROJECT');

  const emptyScenes = validateRolePlayScenePackage(createPackageZip({ project: createProject({ scenes: [] }) }));
  assert.equal(emptyScenes.ok, false);
  assert.equal(emptyScenes.error.code, 'INVALID_ROLEPLAYSCENE_PROJECT');
});

test('validateRolePlayScenePackage rejects invalid manifest JSON distinctly from project JSON', () => {
  const invalidManifestJson = validateRolePlayScenePackage(createStoredZip([
    { path: 'manifest.json', data: '{not json' },
    { path: 'content/project.json', data: JSON.stringify(createProject()) },
  ]));

  assert.equal(invalidManifestJson.ok, false);
  assert.equal(invalidManifestJson.error.code, 'INVALID_ROLEPLAYSCENE_MANIFEST_JSON');
  assert.equal(invalidManifestJson.error.details.reason, 'RolePlayScene package manifest.json is malformed.');
});

test('validateRolePlayScenePackage rejects projects without a start scene', () => {
  const result = validateRolePlayScenePackage(createPackageZip({
    project: createProject({
      scenes: [
        {
          id: 'scene-middle',
          type: 'intermediate',
          dialogue: [{ text: 'No start', audio: null }],
          choices: [],
        },
      ],
    }),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ROLEPLAYSCENE_PROJECT');
});

test('validateRolePlayScenePackage accepts missing referenced media with warning counts', () => {
  const result = validateRolePlayScenePackage(createPackageZip({
    mediaEntries: {
      'media/scene-start/image.png': 'image',
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.metadata.mediaCount, 1);
  assert.equal(result.metadata.missingMediaCount, 1);
  assert.equal(result.metadata.validationWarningCount, 1);
  assert.equal(result.warnings[0].code, 'ROLEPLAYSCENE_MEDIA_MISSING');
  assert.equal(result.warnings[0].path, 'media/scene-start/dialogue-1.mp3');
});

test('validateRolePlayScenePackage allows extra unreferenced media', () => {
  const result = validateRolePlayScenePackage(createPackageZip({
    mediaEntries: {
      'media/scene-start/image.png': 'image',
      'media/scene-start/dialogue-1.mp3': 'audio',
      'media/unused/extra.mp3': 'extra',
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.metadata.mediaCount, 3);
  assert.equal(result.metadata.missingMediaCount, 0);
});

test('RolePlayScene draft artifact bucket stays isolated from worksheet buckets', () => {
  assert.equal(getRolePlaySceneDraftArtifactBucket(), 'roleplayscene/drafts');
  assert.equal(ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET.includes('drafts'), true);
  assert.notEqual(ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET, 'drafts');
  assert.notEqual(ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET, 'attempts');
  assert.notEqual(ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET, 'published');

  const input = createRolePlaySceneDraftArtifactStoreInput({
    identity: { sub: 'owner-sub' },
    uploadedDraftId: 'draft-id',
    zipBytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  });

  assert.deepEqual(input, {
    ownerSub: 'owner-sub',
    bucket: 'roleplayscene/drafts',
    artifactId: 'draft-id',
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  });
});
