import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { canEditProjectTitle, projectTitleInputValue } from '../scripts/project-title.js';
import { prepareProjectImport, createProjectArchive, serializeProject, hydrateProject } from '../scripts/storage.js';
import { validateRolePlayScenePackageForPublish } from '../../api/services/roleplayscene-package.js';

test('project title edits allow 40 Unicode code points, including surrogate pairs', () => {
  for (const char of ['x', '茶', '🍵']) {
    assert.equal(canEditProjectTitle(char.repeat(40), ''), true);
    assert.equal(canEditProjectTitle(char.repeat(41), ''), false);
  }
  assert.equal(canEditProjectTitle('', 'Before'), true);
  assert.equal(canEditProjectTitle(null, ''), false);
  assert.equal(canEditProjectTitle('👩‍🏫'.repeat(14), ''), false, 'joined emoji contain multiple code points');
});

test('unchanged inherited titles survive single-line input normalization', () => {
  const inherited = '茶'.repeat(80) + '\r\n館';
  assert.equal(projectTitleInputValue(inherited), '茶'.repeat(80) + '館');
  assert.equal(canEditProjectTitle(projectTitleInputValue(inherited), inherited), true);
  assert.equal(canEditProjectTitle(inherited + '!', inherited), false);
});

test('legacy titles round-trip local drafts, exported packages and publish validation intact', async () => {
  const title = '舊標題'.repeat(40) + '\r\n🍵';
  const raw = { meta: { title }, scenes: [
    { id: 'start', type: 'start', dialogue: [], choices: [{ id: 'next', label: 'Finish', nextSceneId: 'end' }] },
    { id: 'end', type: 'end', dialogue: [], choices: [] },
  ] };
  const { project } = await prepareProjectImport(new File([JSON.stringify(raw)], 'legacy.json'));
  assert.equal(hydrateProject(serializeProject(project)).meta.title, title);
  const { archiveData } = await createProjectArchive(project);
  assert.equal(validateRolePlayScenePackageForPublish(archiveData).ok, true);
  const imported = await prepareProjectImport(new File([archiveData], 'legacy.zip'));
  assert.equal(imported.project.meta.title, title);
});
