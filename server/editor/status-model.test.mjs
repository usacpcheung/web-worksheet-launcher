import test from 'node:test';
import assert from 'node:assert/strict';
import { getEditorStatusModel } from './status-model.js';
import { t } from '../app/i18n/index.js';
const state = (extra = {}) => ({ draft: { localId: 'd', blocks: [{ blockId: 'reading' }, { blockId: 'mc' }] }, draftRevision: 3, lastSavedRevision: 3, validationErrors: [], ...extra });
test('status keeps failed/pending/unsaved/saved state distinct from validation', () => {
  const base = state({ validationErrors: ['draft.blocks[1].responseConfig.options contains duplicate values: Water'] });
  assert.equal(getEditorStatusModel(base, t).saveState, 'saved');
  assert.equal(getEditorStatusModel(base, t).issueCount, 1);
  assert.equal(getEditorStatusModel({ ...base, lastPersistenceError: 'Storage full', autosavePending: true }, t).tone, 'error');
  assert.equal(getEditorStatusModel({ ...base, autosavePending: true }, t).saveState, 'saving');
  assert.equal(getEditorStatusModel({ ...base, draftRevision: 4 }, t).saveState, 'unsaved');
});
test('issues group by unique block identity or feedback; global errors have no guessed target', () => {
  const result = getEditorStatusModel(state({ validationErrors: [
    'draft.blocks[1].responseConfig.options: Each option needs text or an image.',
    'draft.blocks[1].responseConfig.options contains duplicate values: Water',
    'draft.blocks[0].content.text is required for content blocks',
    'feedback: enter 1–5 learning targets and select at least one assessment category.',
    'A worksheet supports at most 3 image-response questions.',
    'draft.blocks[9].kind must be content or question',
  ] }), t);
  assert.equal(result.groups.length, 4);
  assert.deepEqual(result.groups[0].target, { kind: 'block', blockId: 'mc' });
  assert.equal(result.groups[0].messages.length, 2);
  assert.deepEqual(result.groups[2].target, { kind: 'feedback' });
  assert.equal(result.groups[3].target, null);
  assert.equal(result.groups[3].messages.length, 2);
});
test('duplicate or missing block IDs never produce ambiguous navigation', () => {
  const s = state({ draft: { localId: 'd', blocks: [{ blockId: 'x' }, { blockId: 'x' }, {}] }, validationErrors: ['draft.blocks[0].blockId must be unique', 'draft.blocks[2].blockId must be a non-empty string'] });
  assert.equal(getEditorStatusModel(s, t).groups.every(group => !group.target), true);
});
test('last-save warnings are preserved separately and do not invent current issues or title validation', () => {
  const result = getEditorStatusModel(state({ lastValidationWarning: 'Last snapshot had 2 issues', lastSavedAt: 'bad date' }), t);
  assert.equal(result.issueCount, 0); assert.equal(result.groups.length, 0);
  assert.equal(result.warning, 'Last snapshot had 2 issues'); assert.equal(result.tone, 'warn');
  assert.equal(result.savedTime, t('editor.saveTime.unknown'));
  assert.equal(getEditorStatusModel(state({ lastSavedRevision: 0, draftRevision: 0 }), t).savedTime, t('editor.saveTime.never'));
});
test('reordering maps the current validation index to the current stable block ID', () => {
  const s = state({ validationErrors: ['draft.blocks[0].content.text is required'] });
  assert.equal(getEditorStatusModel(s, t).groups[0].target.blockId, 'reading');
  s.draft.blocks.reverse();
  assert.equal(getEditorStatusModel(s, t).groups[0].target.blockId, 'mc');
});

test('known validation messages stay actionable without exposing technical paths', async () => {
  const { setLocale } = await import('../app/i18n/index.js');
  try {
    for (const locale of ['en', 'zh-Hant']) {
      setLocale(locale, { persist: false });
      const result = getEditorStatusModel(state({ validationErrors: ['draft.blocks[1].responseConfig.options contains duplicate values: <b>Water</b>', 'feedback: enter 1–5 learning targets and select at least one assessment category.'] }), t);
      assert.ok(result.groups[0].messages[0].includes('<b>Water</b>'));
      assert.ok(!result.groups[0].messages[0].includes('responseConfig'));
      assert.equal(result.groups[1].messages[0], t('editorStatus.feedbackTargets'));
    }
  } finally { setLocale('en', { persist: false }); }
});

test('save failure explanation distinguishes saved content from unsaved edits', () => {
  const unchanged = getEditorStatusModel(state({ lastPersistenceError: 'Write failed' }), t);
  assert.equal(unchanged.errorExplanation, t('editorStatus.savedBeforeFailure'));
  const edited = getEditorStatusModel(state({ lastPersistenceError: 'Write failed', draftRevision: 4 }), t);
  assert.equal(edited.errorExplanation, t('editorStatus.unsavedAfterFailure'));
  assert.equal(getEditorStatusModel(state(), t).errorExplanation, '');
});
