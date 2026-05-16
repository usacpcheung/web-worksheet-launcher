import assert from 'node:assert/strict';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { Store } from '../scripts/state.js';
import { createProject, createScene, SceneType } from '../scripts/model.js';
import {
  serializeProject,
  hydrateProject,
  revokeProjectObjectUrls,
  setupPersistence,
  createProjectArchive,
  importProject,
  prepareProjectImport,
  applyPreparedProjectImport,
  extractProjectFromArchive,
  ImportErrorCode,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
} from '../scripts/storage.js';
import { zip, unzip } from '../scripts/utils/zip.js';
import { translate, setActiveLocale } from '../scripts/i18n.js';
import { newId, resetIdSequences } from '../scripts/utils/id.js';

if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = NodeBlob;
}
if (typeof globalThis.File === 'undefined') {
  globalThis.File = NodeFile;
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const revokedUrls = [];
let urlCounter = 0;

URL.createObjectURL = (blob) => {
  assert.ok(blob instanceof Blob, 'serialize/hydrate should pass Blob instances to URL.createObjectURL');
  const url = `blob:test-${urlCounter += 1}`;
  return url;
};

URL.revokeObjectURL = (url) => {
  revokedUrls.push(url);
};

const imageBlob = new Blob(['image-data'], { type: 'text/plain' });
const audioBlob = new Blob(['audio-data'], { type: 'audio/mpeg' });

const sourceProject = createProject({
  meta: { title: 'Persistent Adventure', version: 3 },
  scenes: [
    createScene({
      id: 'scene-1',
      type: SceneType.START,
      image: { name: 'cover.png', objectUrl: 'blob:legacy-img', blob: imageBlob },
      backgroundAudio: { name: 'bg.mp3', objectUrl: 'blob:legacy-bg', blob: audioBlob },
      dialogue: [
        { text: 'Welcome!', audio: { name: 'line.mp3', objectUrl: 'blob:legacy-line', blob: audioBlob } },
      ],
      choices: [{ id: 'choice-1', label: 'Continue', nextSceneId: 'scene-end', cueCardText: 'Keep eye contact.' }],
    }),
    createScene({
      id: 'scene-end',
      type: SceneType.END,
      dialogue: [{ text: 'Goodbye', audio: null }],
      choices: [],
    }),
  ],
});

const serialised = serializeProject(sourceProject);
assert.ok(serialised);
assert.strictEqual(serialised.meta.title, 'Persistent Adventure');
assert.strictEqual(serialised.scenes[0].image.blob, imageBlob, 'image blob should survive serialisation');
assert.strictEqual(serialised.scenes[0].image.objectUrl, undefined, 'objectUrl should be stripped from serialised data');
assert.strictEqual(serialised.scenes[0].choices[0].cueCardText, 'Keep eye contact.', 'cue card text should be serialised');

const hydrated = hydrateProject(serialised, { previousProject: sourceProject });
assert.strictEqual(hydrated.meta.title, 'Persistent Adventure');
assert.strictEqual(hydrated.scenes[0].image.blob, imageBlob, 'image blob should survive hydration');
assert.ok(typeof hydrated.scenes[0].image.objectUrl === 'string', 'hydrated image should receive a fresh objectUrl');
assert.notStrictEqual(hydrated.scenes[0].image.objectUrl, 'blob:legacy-img', 'hydrated objectUrl should differ from legacy value');
assert.ok(revokedUrls.includes('blob:legacy-img'), 'previous image objectUrl should be revoked');
assert.ok(revokedUrls.includes('blob:legacy-bg'), 'previous bg audio objectUrl should be revoked');
assert.ok(revokedUrls.includes('blob:legacy-line'), 'previous dialogue audio objectUrl should be revoked');

revokeProjectObjectUrls(hydrated);
assert.ok(revokedUrls.includes(hydrated.scenes[0].image.objectUrl), 'revoking hydrated project should revoke new objectUrl');

URL.createObjectURL = originalCreateObjectURL;
URL.revokeObjectURL = originalRevokeObjectURL;

const store = new Store();
let persistenceMessage = '';
const cleanup = await setupPersistence(store, { showMessage: (msg) => { persistenceMessage = msg; } });
assert.strictEqual(typeof cleanup, 'function', 'setupPersistence should return a cleanup function');
cleanup();
setActiveLocale('en');
const resolvedPersistenceMessage = typeof persistenceMessage === 'string'
  ? persistenceMessage
  : translate(persistenceMessage?.textId, persistenceMessage?.textArgs);
assert.ok(
  typeof resolvedPersistenceMessage === 'string'
  && resolvedPersistenceMessage.includes('Autosave disabled'),
  'fallback message should mention autosave being disabled',
);

const exportStore = new Store();
exportStore.set({ project: hydrated });
const { archiveData, payload } = await createProjectArchive(exportStore.get().project);
assert.ok(archiveData instanceof Uint8Array, 'archive should return Uint8Array data');
assert.strictEqual(payload.manifest.format, PACKAGE_FORMAT, 'package format should be recorded');
assert.strictEqual(payload.manifest.packageVersion, PACKAGE_VERSION, 'package version should be recorded');

const archiveEntries = await unzip(archiveData);
assert.ok(archiveEntries['manifest.json'], 'archive must contain manifest.json');
assert.ok(archiveEntries['content/project.json'], 'archive must contain content/project.json');
assert.ok(!archiveEntries['project.json'], 'new package export should not write root project.json');
const mediaPaths = Object.keys(archiveEntries).filter(key => key.startsWith('media/'));
assert.strictEqual(mediaPaths.length, 3, 'image + background audio + dialogue audio should be exported');
const packageManifestJson = JSON.parse(new TextDecoder().decode(archiveEntries['manifest.json']));
assert.strictEqual(packageManifestJson.format, PACKAGE_FORMAT, 'manifest must identify RolePlayScene package format');
assert.strictEqual(packageManifestJson.packageVersion, PACKAGE_VERSION, 'manifest must identify supported package version');
assert.strictEqual(packageManifestJson.project.title, 'Persistent Adventure', 'manifest should include project title');
assert.strictEqual(packageManifestJson.assets.length, 3, 'manifest should describe exported media assets');
assert.ok(
  packageManifestJson.assets.some(asset => asset.kind === 'image' && asset.usage === 'scene_image' && asset.byteLength > 0),
  'manifest should include image asset metadata',
);
const projectJson = JSON.parse(new TextDecoder().decode(archiveEntries['content/project.json']));
assert.strictEqual(projectJson.scenes[0].image.path, mediaPaths.find(path => path.includes('image')), 'project content must reference image path');

const archiveBlob = new Blob([archiveData], { type: 'application/zip' });
const archiveFile = new File([archiveBlob], 'persistent-adventure.zip', { type: 'application/zip' });
const importStore = new Store();
await importProject(importStore, archiveFile);
const importedProject = importStore.get().project;
assert.strictEqual(importedProject.meta.title, 'Persistent Adventure', 'imported project should hydrate meta data');
assert.ok(importedProject.scenes[0].image.blob instanceof Blob, 'image blob should be recreated');
assert.ok(importedProject.scenes[0].backgroundAudio.blob instanceof Blob, 'background audio blob should be recreated');
assert.ok(importedProject.scenes[0].dialogue[0].audio.blob instanceof Blob, 'dialogue audio blob should be recreated');
assert.ok(typeof importedProject.scenes[0].image.objectUrl === 'string', 'image object URL should be restored');
assert.strictEqual(await importedProject.scenes[0].image.blob.text(), 'image-data', 'image blob data should round-trip');
assert.strictEqual(await importedProject.scenes[0].dialogue[0].audio.blob.text(), 'audio-data', 'dialogue audio data should round-trip');
assert.strictEqual(importedProject.scenes[0].choices[0].cueCardText, 'Keep eye contact.', 'cue card text should round-trip through archive import');

const legacySnapshot = {
  meta: { title: 'Legacy Project', version: 1 },
  scenes: [
    {
      id: 'scene-legacy',
      type: SceneType.START,
      image: { name: 'legacy.png' },
      backgroundAudio: null,
      dialogue: [{ text: 'Hi there', audio: { name: 'legacy.mp3' } }],
      choices: [{ id: 'legacy-choice', label: 'Next', nextSceneId: 'scene-legacy-end' }],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'scene-legacy-end',
      type: SceneType.END,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'Bye', audio: null }],
      choices: [],
      autoNextSceneId: null,
      notes: '',
    },
  ],
  assets: [],
};
const legacyFile = new File([JSON.stringify(legacySnapshot, null, 2)], 'legacy.json', { type: 'application/json' });
const legacyStore = new Store();
await importProject(legacyStore, legacyFile);
const legacyProject = legacyStore.get().project;
assert.strictEqual(legacyProject.meta.title, 'Legacy Project', 'legacy import should hydrate meta');
assert.ok(!legacyProject.scenes[0].image.blob, 'legacy import should leave missing media blobs null');
assert.ok(!legacyProject.scenes[0].dialogue[0].audio.blob, 'legacy dialogue audio should be null without binary');
assert.strictEqual(legacyProject.scenes[0].choices[0].cueCardText, '', 'legacy choices without cueCardText should default to empty string');

const legacyArchive = await zip({
  'project.json': new TextEncoder().encode(JSON.stringify({
    manifestVersion: 1,
    project: {
      meta: { title: 'Legacy Zip Project', version: 1 },
      scenes: [
        {
          id: 'legacy-zip-start',
          type: SceneType.START,
          image: { name: 'legacy.png', type: 'image/png', size: 11, path: 'media/legacy/image.png' },
          backgroundAudio: null,
          dialogue: [{ text: 'Legacy zip', audio: null }],
          choices: [{ id: 'legacy-zip-choice', label: 'Done', nextSceneId: 'legacy-zip-end' }],
          autoNextSceneId: null,
          notes: '',
        },
        {
          id: 'legacy-zip-end',
          type: SceneType.END,
          image: null,
          backgroundAudio: null,
          dialogue: [{ text: 'Done', audio: null }],
          choices: [],
          autoNextSceneId: null,
          notes: '',
        },
      ],
      assets: [],
    },
  })),
  'media/legacy/image.png': new TextEncoder().encode('legacy-data'),
});
const legacyArchiveFile = new File(
  [new Blob([legacyArchive], { type: 'application/zip' })],
  'legacy-zip-project.zip',
  { type: 'application/zip' },
);
const legacyArchiveStore = new Store();
await importProject(legacyArchiveStore, legacyArchiveFile);
assert.strictEqual(legacyArchiveStore.get().project.meta.title, 'Legacy Zip Project', 'legacy ZIP import should still work');
assert.strictEqual(
  await legacyArchiveStore.get().project.scenes[0].image.blob.text(),
  'legacy-data',
  'legacy ZIP media should still hydrate',
);
const { archiveData: convertedArchiveData } = await createProjectArchive(legacyArchiveStore.get().project);
const convertedEntries = await unzip(convertedArchiveData);
assert.ok(convertedEntries['manifest.json'], 'legacy import followed by export should write new manifest.json format');
assert.ok(convertedEntries['content/project.json'], 'legacy import followed by export should write content/project.json');
assert.ok(!convertedEntries['project.json'], 'legacy import followed by export should not write root project.json');


const plainImportSnapshot = {
  meta: { title: 'Plain Import', version: 2 },
  scenes: [
    {
      id: 'scene-plain',
      type: SceneType.START,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'Hello', audio: null }],
      choices: [{ id: 'plain-choice', label: 'Go', nextSceneId: 'scene-plain-end' }],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'scene-plain-end',
      type: SceneType.END,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'End', audio: null }],
      choices: [],
      autoNextSceneId: null,
      notes: '',
    },
  ],
  assets: [],
};
const plainFile = new File([JSON.stringify(plainImportSnapshot, null, 2)], 'plain.json', { type: 'application/json' });
const plainStore = new Store();
await importProject(plainStore, plainFile);
const plainHydrated = hydrateProject(serializeProject(plainStore.get().project));
assert.strictEqual(plainHydrated.scenes[0].choices[0].cueCardText, '', 'plain JSON import + hydrate should default cueCardText to empty string');


const seededSnapshot = {
  meta: { title: 'Seeded Import', version: 1 },
  scenes: [
    {
      id: 'scene-001',
      type: SceneType.START,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'A', audio: null }],
      choices: [{ id: 'choice-0007', label: 'Go', nextSceneId: 'scene-002' }],
      autoNextSceneId: null,
      notes: '',
    },
    {
      id: 'scene-002',
      type: SceneType.END,
      image: null,
      backgroundAudio: null,
      dialogue: [{ text: 'B', audio: null }],
      choices: [],
      autoNextSceneId: null,
      notes: '',
    },
  ],
  assets: [],
};
const seededFile = new File([JSON.stringify(seededSnapshot, null, 2)], 'seeded.json', { type: 'application/json' });
const seededStore = new Store();
resetIdSequences();
await importProject(seededStore, seededFile);
assert.strictEqual(newId('scene'), 'scene-003', 'imported scene IDs should reseed scene sequence');
assert.strictEqual(newId('choice'), 'choice-0008', 'imported choice IDs should reseed choice sequence');


const zipHydrateProject = hydrateProject(await extractProjectFromArchive(archiveFile));
assert.strictEqual(zipHydrateProject.scenes[0].choices[0].cueCardText, 'Keep eye contact.', 'zip extract + hydrate should preserve cueCardText');

const cueRoundTripProject = createProject({
  meta: { title: 'Cue Round Trip', version: 1 },
  scenes: [
    createScene({
      id: 'scene-a',
      type: SceneType.START,
      dialogue: [{ text: 'Line A', audio: null }],
      choices: [{ id: 'choice-a', label: 'Next', nextSceneId: 'scene-b', cueCardText: 'Pause after greeting.' }],
    }),
    createScene({
      id: 'scene-b',
      type: SceneType.END,
      dialogue: [{ text: 'Line B', audio: null }],
      choices: [],
    }),
  ],
});

const cueSerialized = serializeProject(cueRoundTripProject);
assert.strictEqual(
  cueSerialized.scenes[0].choices[0].cueCardText,
  'Pause after greeting.',
  'new serialized snapshots should include cueCardText',
);

const { archiveData: cueArchiveData } = await createProjectArchive(cueRoundTripProject);
const cueArchiveEntries = await unzip(cueArchiveData);
const cueManifest = JSON.parse(new TextDecoder().decode(cueArchiveEntries['content/project.json']));
assert.strictEqual(
  cueManifest.scenes[0].choices[0].cueCardText,
  'Pause after greeting.',
  'new archive project content should include cueCardText',
);

const cueArchiveFile = new File([new Blob([cueArchiveData], { type: 'application/zip' })], 'cue-round-trip.zip', { type: 'application/zip' });
const cueImported = hydrateProject(await extractProjectFromArchive(cueArchiveFile));
assert.strictEqual(
  cueImported.scenes[0].choices[0].cueCardText,
  'Pause after greeting.',
  'cueCardText should survive archive export/import round-trip without data loss',
);

const existingProject = createProject({
  meta: { title: 'Existing Project', version: 1 },
  scenes: [
    createScene({
      id: 'existing-start',
      type: SceneType.START,
      dialogue: [{ text: 'Keep me', audio: null }],
      choices: [{ id: 'existing-choice', label: 'Done', nextSceneId: 'existing-end' }],
    }),
    createScene({
      id: 'existing-end',
      type: SceneType.END,
      dialogue: [{ text: 'Done', audio: null }],
      choices: [],
    }),
  ],
});

const replacementProject = createProject({
  meta: { title: 'Replacement Project', version: 1 },
  scenes: [
    createScene({
      id: 'replacement-start',
      type: SceneType.START,
      dialogue: [{ text: 'Replace me in only after confirm', audio: null }],
      choices: [{ id: 'replacement-choice', label: 'Done', nextSceneId: 'replacement-end' }],
    }),
    createScene({
      id: 'replacement-end',
      type: SceneType.END,
      dialogue: [{ text: 'Done', audio: null }],
      choices: [],
    }),
  ],
});

const replacementFile = new File(
  [JSON.stringify(serializeProject(replacementProject), null, 2)],
  'replacement.json',
  { type: 'application/json' },
);
const safetyStore = new Store();
safetyStore.set({ project: existingProject });
const preparedReplacement = await prepareProjectImport(replacementFile);
assert.strictEqual(
  safetyStore.get().project.meta.title,
  'Existing Project',
  'preparing an import must not mutate the current store before confirmation',
);
revokeProjectObjectUrls(preparedReplacement.project);

const confirmedStore = new Store();
confirmedStore.set({ project: existingProject });
const confirmedPrepared = await prepareProjectImport(replacementFile);
await applyPreparedProjectImport(confirmedStore, confirmedPrepared);
assert.strictEqual(
  confirmedStore.get().project.meta.title,
  'Replacement Project',
  'applying a prepared import should replace the project after confirmation',
);

const badZipStore = new Store();
badZipStore.set({ project: existingProject });
const badZipFile = new File([new Uint8Array([1, 2, 3])], 'bad.zip', { type: 'application/zip' });
await assert.rejects(
  () => importProject(badZipStore, badZipFile),
  err => err?.code === ImportErrorCode.INVALID_ZIP,
  'invalid ZIP should reject with INVALID_ZIP',
);
assert.strictEqual(badZipStore.get().project.meta.title, 'Existing Project', 'invalid ZIP must not overwrite current project');

const missingProjectArchive = await zip({
  'not-project.json': new TextEncoder().encode('{}'),
});
const missingProjectFile = new File([new Blob([missingProjectArchive], { type: 'application/zip' })], 'missing-project.zip', { type: 'application/zip' });
await assert.rejects(
  () => importProject(badZipStore, missingProjectFile),
  err => err?.code === ImportErrorCode.MISSING_PROJECT_JSON,
  'archive missing project.json should reject with MISSING_PROJECT_JSON',
);
assert.strictEqual(badZipStore.get().project.meta.title, 'Existing Project', 'missing project.json must not overwrite current project');

const missingManifestArchive = await zip({
  'content/project.json': new TextEncoder().encode(JSON.stringify(serializeProject(replacementProject))),
});
const missingManifestFile = new File(
  [new Blob([missingManifestArchive], { type: 'application/zip' })],
  'missing-manifest.zip',
  { type: 'application/zip' },
);
await assert.rejects(
  () => importProject(badZipStore, missingManifestFile),
  err => err?.code === ImportErrorCode.MISSING_PACKAGE_MANIFEST,
  'new package missing manifest.json should reject safely',
);
assert.strictEqual(badZipStore.get().project.meta.title, 'Existing Project', 'missing manifest.json must not overwrite current project');

const missingContentProjectArchive = await zip({
  'manifest.json': new TextEncoder().encode(JSON.stringify({
    format: PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION,
    project: { title: 'Missing Content Project', version: 1 },
    assets: [],
  })),
});
const missingContentProjectFile = new File(
  [new Blob([missingContentProjectArchive], { type: 'application/zip' })],
  'missing-content-project.zip',
  { type: 'application/zip' },
);
await assert.rejects(
  () => importProject(badZipStore, missingContentProjectFile),
  err => err?.code === ImportErrorCode.MISSING_PACKAGE_PROJECT,
  'new package missing content/project.json should reject safely',
);
assert.strictEqual(badZipStore.get().project.meta.title, 'Existing Project', 'missing content/project.json must not overwrite current project');

const unsupportedPackageArchive = await zip({
  'manifest.json': new TextEncoder().encode(JSON.stringify({
    format: 'other-package',
    packageVersion: PACKAGE_VERSION,
    project: { title: 'Unsupported', version: 1 },
    assets: [],
  })),
  'content/project.json': new TextEncoder().encode(JSON.stringify(serializeProject(replacementProject))),
});
const unsupportedPackageFile = new File(
  [new Blob([unsupportedPackageArchive], { type: 'application/zip' })],
  'unsupported-package.zip',
  { type: 'application/zip' },
);
await assert.rejects(
  () => importProject(badZipStore, unsupportedPackageFile),
  err => err?.code === ImportErrorCode.UNSUPPORTED_PACKAGE,
  'unsupported manifest format should reject safely',
);
assert.strictEqual(badZipStore.get().project.meta.title, 'Existing Project', 'unsupported package must not overwrite current project');

const unsupportedVersionArchive = await zip({
  'manifest.json': new TextEncoder().encode(JSON.stringify({
    format: PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION + 1,
    project: { title: 'Unsupported Version', version: 1 },
    assets: [],
  })),
  'content/project.json': new TextEncoder().encode(JSON.stringify(serializeProject(replacementProject))),
});
const unsupportedVersionFile = new File(
  [new Blob([unsupportedVersionArchive], { type: 'application/zip' })],
  'unsupported-version.zip',
  { type: 'application/zip' },
);
await assert.rejects(
  () => importProject(badZipStore, unsupportedVersionFile),
  err => err?.code === ImportErrorCode.UNSUPPORTED_PACKAGE,
  'unsupported manifest packageVersion should reject safely',
);
assert.strictEqual(badZipStore.get().project.meta.title, 'Existing Project', 'unsupported package version must not overwrite current project');

const invalidContentProjectArchive = await zip({
  'manifest.json': new TextEncoder().encode(JSON.stringify({
    format: PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION,
    project: { title: 'Invalid Content', version: 1 },
    assets: [],
  })),
  'content/project.json': new TextEncoder().encode('{not json'),
});
const invalidContentProjectFile = new File(
  [new Blob([invalidContentProjectArchive], { type: 'application/zip' })],
  'invalid-content-project.zip',
  { type: 'application/zip' },
);
await assert.rejects(
  () => importProject(badZipStore, invalidContentProjectFile),
  err => err?.code === ImportErrorCode.INVALID_JSON,
  'invalid content/project.json should reject safely',
);
assert.strictEqual(badZipStore.get().project.meta.title, 'Existing Project', 'invalid content/project.json must not overwrite current project');

const invalidJsonFile = new File(['{not json'], 'invalid.json', { type: 'application/json' });
await assert.rejects(
  () => importProject(badZipStore, invalidJsonFile),
  err => err?.code === ImportErrorCode.INVALID_JSON,
  'invalid JSON should reject with INVALID_JSON',
);
assert.strictEqual(badZipStore.get().project.meta.title, 'Existing Project', 'invalid JSON must not overwrite current project');

const invalidProjectFile = new File(
  [JSON.stringify({ meta: { title: 'Invalid Project' }, scenes: null })],
  'invalid-project.json',
  { type: 'application/json' },
);
await assert.rejects(
  () => importProject(badZipStore, invalidProjectFile),
  err => err?.code === ImportErrorCode.INVALID_PROJECT,
  'structurally invalid project should reject with INVALID_PROJECT',
);
assert.strictEqual(badZipStore.get().project.meta.title, 'Existing Project', 'structurally invalid project must not overwrite current project');

const incompleteDraftProject = createProject({
  meta: { title: 'Incomplete Draft', version: 1 },
  scenes: [
    createScene({
      id: 'draft-start',
      type: SceneType.START,
      dialogue: [{ text: 'Still drafting', audio: null }],
      choices: [{ id: 'draft-choice', label: 'Unlinked', nextSceneId: null }],
    }),
  ],
});
const { archiveData: incompleteDraftArchiveData } = await createProjectArchive(incompleteDraftProject);
const incompleteDraftFile = new File(
  [new Blob([incompleteDraftArchiveData], { type: 'application/zip' })],
  'incomplete-draft.zip',
  { type: 'application/zip' },
);
const incompleteDraftPrepared = await prepareProjectImport(incompleteDraftFile);
assert.strictEqual(
  incompleteDraftPrepared.project.meta.title,
  'Incomplete Draft',
  'exported editable drafts with no end scene or complete connections should import back successfully',
);
assert.deepStrictEqual(
  incompleteDraftPrepared.validation.errors,
  [],
  'import preparation should not report play validation errors for incomplete drafts',
);
assert.deepStrictEqual(
  incompleteDraftPrepared.validation.warnings,
  [],
  'import preparation should leave graph completeness warnings to Play validation',
);
revokeProjectObjectUrls(incompleteDraftPrepared.project);

const missingMediaArchive = await zip({
  'project.json': new TextEncoder().encode(JSON.stringify({
    manifestVersion: 1,
    project: {
      meta: { title: 'Missing Media Archive', version: 1 },
      scenes: [
        {
          id: 'missing-media-start',
          type: SceneType.START,
          image: { name: 'missing.png', type: 'image/png', size: 100, path: 'media/missing/image.png' },
          backgroundAudio: null,
          dialogue: [
            {
              text: 'Missing audio',
              audio: { name: 'missing.mp3', type: 'audio/mpeg', size: 100, path: 'media/missing/dialogue.mp3' },
            },
          ],
          choices: [{ id: 'missing-media-choice', label: 'Done', nextSceneId: 'missing-media-end', cueCardText: '' }],
          autoNextSceneId: null,
          notes: '',
        },
        {
          id: 'missing-media-end',
          type: SceneType.END,
          image: null,
          backgroundAudio: null,
          dialogue: [{ text: 'Done', audio: null }],
          choices: [],
          autoNextSceneId: null,
          notes: '',
        },
      ],
      assets: [],
    },
  })),
});
const missingMediaFile = new File(
  [new Blob([missingMediaArchive], { type: 'application/zip' })],
  'missing-media.zip',
  { type: 'application/zip' },
);
const missingMediaPrepared = await prepareProjectImport(missingMediaFile);
assert.ok(
  missingMediaPrepared.missingMediaPaths.length >= 2,
  'legacy import with missing media should prepare successfully with warning-only missing media paths',
);
revokeProjectObjectUrls(missingMediaPrepared.project);

const missingMediaV2Archive = await zip({
  'manifest.json': new TextEncoder().encode(JSON.stringify({
    format: PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION,
    project: { title: 'Missing Media V2 Archive', version: 1 },
    assets: [
      {
        path: 'media/missing-v2/image.png',
        kind: 'image',
        usage: 'scene_image',
        byteLength: 100,
      },
    ],
  })),
  'content/project.json': new TextEncoder().encode(JSON.stringify({
    meta: { title: 'Missing Media V2 Archive', version: 1 },
    scenes: [
      {
        id: 'missing-media-v2-start',
        type: SceneType.START,
        image: { name: 'missing.png', type: 'image/png', size: 100, path: 'media/missing-v2/image.png' },
        backgroundAudio: null,
        dialogue: [{ text: 'Missing v2 media', audio: null }],
        choices: [{ id: 'missing-media-v2-choice', label: 'Done', nextSceneId: 'missing-media-v2-end', cueCardText: '' }],
        autoNextSceneId: null,
        notes: '',
      },
      {
        id: 'missing-media-v2-end',
        type: SceneType.END,
        image: null,
        backgroundAudio: null,
        dialogue: [{ text: 'Done', audio: null }],
        choices: [],
        autoNextSceneId: null,
        notes: '',
      },
    ],
    assets: [],
  })),
});
const missingMediaV2File = new File(
  [new Blob([missingMediaV2Archive], { type: 'application/zip' })],
  'missing-media-v2.zip',
  { type: 'application/zip' },
);
const missingMediaV2Prepared = await prepareProjectImport(missingMediaV2File);
assert.ok(
  missingMediaV2Prepared.missingMediaPaths.includes('media/missing-v2/image.png'),
  'new package import with missing media should prepare successfully with warning-only missing media paths',
);
revokeProjectObjectUrls(missingMediaV2Prepared.project);

console.log('storage persistence helpers tests passed');
