import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../scripts/main.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const newStoryMarkupIndex = indexSource.indexOf('id="new-story-btn"');
const importMarkupIndex = indexSource.indexOf('id="import-btn"');
assert.ok(newStoryMarkupIndex > -1, 'New Story toolbar action should exist');
assert.ok(newStoryMarkupIndex < importMarkupIndex, 'New Story should appear before Import');

const handlerIndex = mainSource.indexOf("btnNewStory?.addEventListener('click'");
const discussionConfirmIndex = mainSource.indexOf(
  'if (!(await ensureDiscussionCanBeDiscarded())) return',
  handlerIndex,
);
const confirmIndex = mainSource.indexOf('const shouldStart = await confirmNewStory()', handlerIndex);
const resetSequenceIndex = mainSource.indexOf('resetIdSequences()', handlerIndex);
const replaceIndex = mainSource.indexOf(
  'applyPreparedProjectImport(store, { project: createProject() })',
  handlerIndex,
);
const editModeIndex = mainSource.indexOf("setMode('edit')", handlerIndex);

assert.ok(handlerIndex > -1, 'New Story click handler should exist');
assert.ok(
  discussionConfirmIndex > handlerIndex && discussionConfirmIndex < confirmIndex,
  'New Story should protect unsaved discussion text before replacement confirmation',
);
assert.ok(confirmIndex > handlerIndex, 'New Story should request confirmation');
assert.ok(
  resetSequenceIndex > confirmIndex && resetSequenceIndex < replaceIndex,
  'New Story should reset generated IDs after confirmation and before creating the replacement project',
);
assert.ok(replaceIndex > confirmIndex, 'New Story should replace the project only after confirmation');
assert.ok(editModeIndex > replaceIndex, 'New Story should return to Edit mode after replacement');
assert.ok(
  mainSource.includes("NEW_STORY: 'new-story'"),
  'New Story should use the shared confirmation dialog with a dedicated kind',
);
assert.ok(
  mainSource.includes("moveToolbarNode(btnNewStory, toolbarMoreProjectItems)"),
  'New Story should move into the Project overflow group on narrower layouts',
);

console.log('new story source tests passed');
