import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RolePlaySceneDiscussionSession, computeDiscussionProjectFingerprint } from '../scripts/player/discussion-state.js';
import { buildDiscussionPrintHtml, buildDiscussionPrintModel } from '../scripts/player/discussion-print.js';
import { SceneType } from '../scripts/model.js';

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

const project = {
  meta: { title: 'Discussion Story', version: 1 },
  speakers: [{ id: 'speaker-a', name: 'Ada' }],
  scenes: [
    {
      id: 'start',
      type: SceneType.START,
      image: { objectUrl: 'blob:start' },
      dialogue: [{ speakerId: 'speaker-a', text: 'Start line' }],
      choices: [{ id: 'c1', label: 'Go middle', nextSceneId: 'middle', cueCardText: 'Think first' }],
    },
    {
      id: 'middle',
      type: SceneType.INTERMEDIATE,
      dialogue: [{ text: 'Middle line' }],
      choices: [{ id: 'c2', label: 'Finish', nextSceneId: 'end' }],
    },
    {
      id: 'end',
      type: SceneType.END,
      dialogue: [{ text: 'End line' }],
      choices: [],
    },
  ],
};

test('discussion session stores text by scene and clears undo on manual input', () => {
  const session = new RolePlaySceneDiscussionSession({ storage: createMemoryStorage() });
  session.bindProject(project);
  session.setText('start', 'first answer');
  session.undoBySceneId = { start: 'before rewrite' };
  session.setText('start', 'manual edit');

  assert.equal(session.getText('start'), 'manual edit');
  assert.equal(session.hasUndo('start'), false);
  assert.equal(session.hasAnyText(), true);
});

test('discussion session restores only matching project fingerprint from session storage', () => {
  const storage = createMemoryStorage();
  const session = new RolePlaySceneDiscussionSession({ storage });
  session.bindProject(project);
  session.setText('start', 'saved text');

  const restored = new RolePlaySceneDiscussionSession({ storage });
  restored.bindProject(project);
  assert.equal(restored.getText('start'), 'saved text');

  const changedProject = {
    ...project,
    scenes: [...project.scenes, { id: 'extra', type: SceneType.INTERMEDIATE, dialogue: [], choices: [] }],
  };
  assert.notEqual(computeDiscussionProjectFingerprint(project), computeDiscussionProjectFingerprint(changedProject));

  const mismatched = new RolePlaySceneDiscussionSession({ storage });
  mismatched.bindProject(changedProject);
  assert.equal(mismatched.getText('start'), '');
});

test('discussion rewrite applies fresh result and undo restores snapshot', async () => {
  const session = new RolePlaySceneDiscussionSession({
    storage: createMemoryStorage(),
    apiClient: {
      rewriteText: async text => ({ ok: true, data: { text: `${text} rewritten` } }),
    },
  });
  session.bindProject(project);
  session.setText('start', 'original');

  const result = await session.rewrite('start', 'original');
  assert.equal(result.status, 'rewrite_applied');
  assert.equal(session.getText('start'), 'original rewritten');
  assert.equal(session.hasUndo('start'), true);

  assert.equal(session.undo('start'), true);
  assert.equal(session.getText('start'), 'original');
  assert.equal(session.hasUndo('start'), false);
});

test('discussion rewrite failure and stale context preserve current text', async () => {
  const failing = new RolePlaySceneDiscussionSession({
    storage: createMemoryStorage(),
    apiClient: { rewriteText: async () => ({ ok: false, error: { message: 'failed' } }) },
  });
  failing.bindProject(project);
  failing.setText('start', 'keep me');
  const failed = await failing.rewrite('start', 'keep me');
  assert.equal(failed.status, 'rewrite_failed');
  assert.equal(failing.getText('start'), 'keep me');

  let resolveRewrite;
  const stale = new RolePlaySceneDiscussionSession({
    storage: createMemoryStorage(),
    apiClient: {
      rewriteText: () => new Promise(resolve => {
        resolveRewrite = resolve;
      }),
    },
  });
  stale.bindProject(project);
  stale.setText('start', 'before');
  const pending = stale.rewrite('start', 'before');
  stale.setText('start', 'changed while rewriting');
  resolveRewrite({ ok: true, data: { text: 'should not apply' } });
  const result = await pending;
  assert.equal(result.status, 'rewrite_stale_context');
  assert.equal(stale.getText('start'), 'changed while rewriting');
});

test('discussion print model filters text scenes and sorts by graph layout order', () => {
  const model = buildDiscussionPrintModel(project, {
    discussionBySceneId: {
      end: { text: 'ending thoughts' },
      middle: { text: 'middle thoughts' },
      start: { text: 'start thoughts' },
    },
  });

  assert.deepEqual(model.cards.map(card => card.sceneId), ['start', 'middle', 'end']);
  assert.equal(model.cards[0].image.src, 'blob:start');
  assert.equal(model.cards[0].dialogue[0].speaker, 'Ada');
  assert.deepEqual(model.cards[0].choices, ['Go middle']);
});

test('discussion print model excludes blank and duplicate scene entries', () => {
  const model = buildDiscussionPrintModel(project, {
    discussionBySceneId: {
      start: { text: '  ' },
      middle: { text: 'only this' },
    },
  });

  assert.deepEqual(model.cards.map(card => card.sceneId), ['middle']);
});

test('discussion print html uses fixed print report layout and metadata header', () => {
  const model = buildDiscussionPrintModel(project, {
    discussionBySceneId: {
      start: { text: 'start thoughts' },
      middle: { text: 'middle thoughts' },
    },
  });
  const html = buildDiscussionPrintHtml(model, {
    reportTitle: 'Discussion Report',
    dialogue: 'Dialogue',
    choices: 'Choices',
    discussion: 'Discussion',
    empty: 'No discussion text yet.',
    student: 'Name',
    date: 'Date',
    defaultSchoolName: 'Hong Kong Red Cross Hospital Schools',
  }, {
    schoolName: 'Hong Kong Red Cross Hospital Schools',
    studentName: 'Ada Student',
    printedAt: '30 May 2026',
  });

  assert.equal(html.includes('@page { size: A4 portrait;'), true);
  assert.equal(html.includes('.discussion-print-school'), true);
  assert.equal(html.includes('text-align: center;'), true);
  assert.equal(html.includes('Hong Kong Red Cross Hospital Schools'), true);
  assert.equal(html.includes('Discussion Story - Discussion Report'), true);
  assert.equal(html.includes('<strong>Name:</strong> Ada Student'), true);
  assert.equal(html.includes('<strong>Date:</strong> 30 May 2026'), true);
  assert.equal(html.includes('grid-template-columns: 26mm 1fr 1.45fr;'), true);
  assert.equal(html.includes('grid-template-columns: 1fr 1.55fr;'), true);
  assert.equal(html.includes('@media (max-width'), false);
  assert.equal(html.includes("window.addEventListener('afterprint'"), true);
  assert.equal(html.includes('window.close()'), true);
  assert.equal(html.includes('Promise.all(images.map'), true);
});

test('player source wires cue and utility discussion entry points', async () => {
  const source = await readFile(path.resolve('server/roleplayscene/scripts/player/ui.js'), 'utf8');
  assert.equal(source.includes("renderDiscussionForm({"), true);
  assert.equal(source.includes("cueText: text,"), true);
  assert.equal(source.includes("const openDiscussion = () => {"), true);
  assert.equal(source.includes("discussionButton.addEventListener('click', () => {"), true);
  assert.equal(source.includes("printButton.addEventListener('click', () => {"), true);
  assert.equal(source.includes('const rewriteTask = discussionSession?.rewrite?.(scene.id, textAtClick, { apiClient });'), true);
  assert.equal(source.includes('await rewriteTask;'), true);
  assert.equal(source.includes("if (typeof latestText === 'string') {"), true);
  assert.equal(source.includes('player-discussion-choice-label'), false);
  assert.equal(source.includes("cueOverlay.addEventListener('click'"), false);
  assert.equal(source.includes("document.addEventListener('pointerdown'"), false);
  assert.equal(source.includes("event.key === 'Escape' && !cueOverlay.hidden"), true);
});

test('main source protects discussion before story-changing actions', async () => {
  const source = await readFile(path.resolve('server/roleplayscene/scripts/main.js'), 'utf8');
  assert.equal(source.includes('async function ensureDiscussionCanBeDiscarded()'), true);
  assert.equal(source.includes('if (!(await ensureDiscussionCanBeDiscarded())) return;'), true);
  assert.equal(source.includes("window.addEventListener('beforeunload', (event) => {"), true);
  assert.equal(source.includes("event.returnValue = '';"), true);
});

test('main source opens print details before discussion print window', async () => {
  const source = await readFile(path.resolve('server/roleplayscene/scripts/main.js'), 'utf8');
  const detailsIndex = source.indexOf('const details = await promptDiscussionPrintDetails();');
  const openIndex = source.indexOf("const printWindow = globalThis.open?.('', 'roleplayscene_discussion_print'");

  assert.equal(source.includes('function promptDiscussionPrintDetails()'), true);
  assert.equal(source.includes("title: translate('player.discussion.printDetailsTitle')"), true);
  assert.equal(source.includes("translate('player.discussion.printSchoolName')"), true);
  assert.equal(source.includes("translate('player.discussion.printStudentName')"), true);
  assert.equal(source.includes('schoolNameCustom: Boolean(rawSchoolName) && rawSchoolName !== getDefaultDiscussionPrintSchoolName()'), true);
  assert.equal(source.includes('unsubscribeLocaleChange = onLocaleChange(() => {'), true);
  assert.equal(source.includes('if (!schoolInput || schoolNameCustom) return;'), true);
  assert.equal(source.includes("studentName: details.studentName"), true);
  assert.equal(source.includes("printedAt: formatDiscussionPrintDate()"), true);
  assert.equal(detailsIndex > -1 && openIndex > detailsIndex, true);
});

test('cue and discussion overlay leaves toolbar language controls reachable', async () => {
  const mainSource = await readFile(path.resolve('server/roleplayscene/scripts/main.js'), 'utf8');
  const cssSource = await readFile(path.resolve('server/roleplayscene/styles/app.css'), 'utf8');

  assert.equal(mainSource.includes('function syncTopbarHeightVariable()'), true);
  assert.equal(mainSource.includes("document.documentElement?.style?.setProperty('--roleplayscene-topbar-height'"), true);
  assert.equal(mainSource.includes('new globalThis.ResizeObserver(() => {'), true);
  assert.equal(cssSource.includes('--roleplayscene-topbar-height: 4rem;'), true);
  assert.equal(cssSource.includes('.topbar {\n  position: relative;\n  z-index: 50;'), true);
  assert.equal(cssSource.includes('top: var(--roleplayscene-topbar-height, 4rem);'), true);
  assert.equal(cssSource.includes('max-height: max(14rem, calc(100vh - var(--roleplayscene-topbar-height, 4rem) - 2rem));'), true);
});

test('main source keeps active import confirmation copy tied to confirmation kind', async () => {
  const source = await readFile(path.resolve('server/roleplayscene/scripts/main.js'), 'utf8');
  assert.equal(source.includes('const ImportConfirmationKind = Object.freeze({'), true);
  assert.equal(source.includes("DISCUSSION_DISCARD: 'discussion-discard'"), true);
  assert.equal(source.includes('function getImportConfirmationCopy(kind = ImportConfirmationKind.IMPORT, options = {})'), true);
  assert.equal(source.includes('function applyImportConfirmationCopy(kind = ImportConfirmationKind.IMPORT, options = {})'), true);
  assert.equal(source.includes('activeImportConfirmation?.kind || ImportConfirmationKind.IMPORT'), true);
  assert.equal(source.includes('activeImportConfirmation = { resolve, previousFocus, kind, options };'), true);
  assert.equal(source.includes('kind: ImportConfirmationKind.DISCUSSION_DISCARD'), true);
});
