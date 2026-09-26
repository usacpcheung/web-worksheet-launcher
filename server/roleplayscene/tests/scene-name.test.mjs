import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createProject, createScene } from '../scripts/model.js';
import { canEditSceneName, fitSceneLabel, getSceneLabel, getSceneName } from '../scripts/scene-name.js';
import { validateSceneIdentity } from '../scripts/scene-identity.js';
import { prepareProjectImport, createProjectArchive, serializeProject, hydrateProject, revokeProjectObjectUrls } from '../scripts/storage.js';
import { zip, unzip } from '../scripts/utils/zip.js';
import { newId, resetIdSequences, seedIdSequencesFromProject } from '../scripts/utils/id.js';
import { RolePlaySceneDiscussionSession, computeDiscussionProjectFingerprint } from '../scripts/player/discussion-state.js';
import { buildDiscussionPrintModel } from '../scripts/player/discussion-print.js';
import { validateRolePlayScenePackage, validateRolePlayScenePackageForPublish, rewriteRolePlayScenePackageTitle } from '../../api/services/roleplayscene-package.js';

function legacyProject() {
  return {
    meta: { title: 'Legacy story', version: 1 },
    scenes: [
      { id: 'scene01', type: 'start', dialogue: [{ text: 'Hello' }], choices: [{ id: 'choice1', nextSceneId: '終點 "茶"', label: 'Next' }] },
      { id: '終點 "茶"', type: 'end', dialogue: [], choices: [] },
    ],
  };
}

test('scene names are additive metadata, preserve long legacy values and count Unicode code points', () => {
  assert.equal(createScene({ id: 'old-id' }).name, 'old-id');
  assert.equal(createScene({ id: 'old-id', name: '  ' }).name, 'old-id');
  const long = '場景'.repeat(80);
  assert.equal(createScene({ id: 'old-id', name: long }).name, long);
  assert.equal(canEditSceneName(long, long), true);
  assert.equal(canEditSceneName(`${long}!`, long), false);
  assert.equal(canEditSceneName('🍵'.repeat(80), ''), true);
  assert.equal(canEditSceneName('🍵'.repeat(81), ''), false);
  assert.equal(getSceneLabel({ id: 'a', name: 'Tea' }), 'Tea · a');
  assert.equal(getSceneLabel({ id: 'a' }), 'a');
  assert.equal(getSceneName({ id: 'a', name: 123 }), 'a');
});

test('map ellipsis fits the measured width without splitting a grapheme', () => {
  const measure = text => Array.from(new Intl.Segmenter().segment(text)).length * 10;
  assert.equal(fitSceneLabel('👩‍🏫abcdef', 30, measure), '👩‍🏫a…');
  assert.equal(fitSceneLabel('Tea', 30, measure), 'Tea');
});

for (const format of ['json', 'legacy-zip', 'package']) {
  test(`${format}: read old IDs/media, write names, then preserve renamed scenes through export/import`, async () => {
    const raw = legacyProject();
    let file;
    if (format === 'json') {
      file = new File([JSON.stringify(raw)], 'old.json');
    } else {
      raw.scenes[0].image = { name: 'tea.png', path: 'media/tea.png', type: 'image/png' };
      const entries = { 'media/tea.png': new Uint8Array([1, 2, 3]) };
      if (format === 'legacy-zip') entries['project.json'] = new TextEncoder().encode(JSON.stringify({ manifestVersion: 1, project: raw }));
      else {
        entries['manifest.json'] = new TextEncoder().encode(JSON.stringify({ format: 'roleplayscene-package', packageVersion: 1 }));
        entries['content/project.json'] = new TextEncoder().encode(JSON.stringify(raw));
      }
      file = new File([await zip(entries)], 'old.zip');
    }
    const { project } = await prepareProjectImport(file);
    try {
      assert.deepEqual(project.scenes.map(s => s.name), raw.scenes.map(s => s.id));
      assert.equal(project.scenes[0].choices[0].nextSceneId, raw.scenes[1].id);
      assert.equal(serializeProject(project).scenes[0].name, 'scene01');
      const legacyExport = await createProjectArchive(project);
      assert.deepEqual(legacyExport.payload.project.scenes.map(s => s.name), raw.scenes.map(s => s.id));
      project.scenes[0].name = '飲茶 <b>literal text</b>';
      project.scenes[1].name = project.scenes[0].name; // Duplicate names are valid.
      const localReload = hydrateProject(serializeProject(project));
      revokeProjectObjectUrls(localReload);
      assert.equal(localReload.scenes[0].name, project.scenes[0].name);
      const { archiveData, payload } = await createProjectArchive(project);
      assert.equal(payload.manifest.packageVersion, 1);
      assert.equal(validateRolePlayScenePackage(archiveData).ok, true);
      assert.equal(validateRolePlayScenePackageForPublish(archiveData).ok, true);
      const renamedPackage = rewriteRolePlayScenePackageTitle(archiveData, 'Copy');
      const rewritten = await unzip(renamedPackage);
      assert.equal(JSON.parse(new TextDecoder().decode(rewritten['content/project.json'])).scenes[0].name, project.scenes[0].name);
      const again = await prepareProjectImport(new File([archiveData], 'roundtrip.zip'));
      assert.deepEqual(serializeProject(again.project), serializeProject(project));
      if (format !== 'json') assert.deepEqual(new Uint8Array(await again.project.scenes[0].image.blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
      revokeProjectObjectUrls(again.project);
    } finally { revokeProjectObjectUrls(project); }
  });
}

test('renaming preserves identity, flow, discussion recovery and printed associations', () => {
  const project = createProject(legacyProject());
  const memory = new Map();
  const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const session = new RolePlaySceneDiscussionSession({ storage });
  session.bindProject(project);
  session.setText('scene01', 'My answer');
  const renamed = { ...project, scenes: project.scenes.map(s => ({ ...s, name: 'Same name' })) };
  assert.equal(computeDiscussionProjectFingerprint(renamed), computeDiscussionProjectFingerprint(project));
  session.bindProject(renamed);
  assert.equal(session.getText('scene01'), 'My answer');
  const restored = new RolePlaySceneDiscussionSession({ storage });
  restored.bindProject(renamed);
  assert.equal(restored.getText('scene01'), 'My answer');
  const print = buildDiscussionPrintModel(renamed, { discussionBySceneId: { scene01: { text: 'My answer' } } });
  assert.equal(print.cards[0].sceneId, 'scene01');
  assert.equal(print.cards[0].title, 'Same name · scene01');
  assert.equal(renamed.scenes[0].choices[0].nextSceneId, '終點 "茶"');
});

test('import checks exact identity before normalization while retaining incomplete drafts', async () => {
  const raw = legacyProject();
  raw.scenes[0].choices[0].nextSceneId = null;
  assert.equal((await prepareProjectImport(new File([JSON.stringify(raw)], 'draft.json'))).project.scenes.length, 2);
  assert.deepEqual(validateSceneIdentity({ scenes: [{ id: 'intro' }, { id: ' intro ' }, { id: 'INTRO' }] }), []);
  for (const invalid of ['', null, 42, undefined, 'scene01']) {
    const broken = legacyProject();
    broken.scenes[1].id = invalid;
    await assert.rejects(prepareProjectImport(new File([JSON.stringify(broken)], 'broken.json')), error => error.code === 'invalid_project' && error.errors[0].includes('scenes[1].id'));
    const bytes = await zip({
      'manifest.json': new TextEncoder().encode(JSON.stringify({ format: 'roleplayscene-package', packageVersion: 1 })),
      'content/project.json': new TextEncoder().encode(JSON.stringify(broken)),
    });
    await assert.rejects(prepareProjectImport(new File([bytes], 'broken.zip')), error => error.code === 'invalid_project');
    assert.equal(validateRolePlayScenePackage(bytes).ok, false);
    assert.equal(validateRolePlayScenePackageForPublish(bytes).error.code, 'INVALID_ROLEPLAYSCENE_PUBLISH_PACKAGE');
  }
});

test('oversized imported suffixes cannot exhaust or collide with generated IDs', () => {
  resetIdSequences();
  seedIdSequencesFromProject({ scenes: [{ id: 'scene-9007199254740992' }, { id: 'scene-9007199254740991' }, { id: 'scene-001' }, { id: 'scene-002' }] });
  assert.equal(newId('scene'), 'scene-003');
  assert.equal(newId('scene'), 'scene-004');
  resetIdSequences();
});
