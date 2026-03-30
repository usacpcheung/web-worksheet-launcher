import test from 'node:test';
import assert from 'node:assert/strict';

import { mapDraftToSnapshot, mapSnapshotToViewerPayload } from './mappers.js';

function buildDraft() {
  return {
    draftWorksheetId: 'draft_1',
    title: 'Worksheet',
    description: 'Desc',
    blocks: [
      {
        blockId: 'q_no_key',
        kind: 'question',
        position: 0,
        prompt: { text: 'No key', format: 'plain_text' },
        responseConfig: { inputType: 'text', maxLength: 120, displayMode: 'multi_line' },
      },
      {
        blockId: 'q_key',
        kind: 'question',
        position: 1,
        prompt: { text: 'Choose all', format: 'plain_text' },
        responseConfig: {
          inputType: 'multiple_choice',
          selectionMode: 'multi',
          options: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }],
          correctAnswer: ['A'],
        },
      },
    ],
  };
}

test('mapDraftToSnapshot preserves valid responseConfig.correctAnswer', () => {
  const draft = buildDraft();
  const snapshot = mapDraftToSnapshot(draft, {
    worksheetId: 'ws_1',
    snapshotId: 'snap_1',
    schemaVersion: 1,
    snapshotVersion: 1,
    publishedAt: '2026-03-29T00:00:00Z',
    publishedByUserId: 'user_1',
    sourceDraftRevision: 'rev_1',
  });

  const questionWithKey = snapshot.blocks.find((block) => block.blockId === 'q_key');
  const questionWithoutKey = snapshot.blocks.find((block) => block.blockId === 'q_no_key');
  assert.deepEqual(questionWithKey.responseConfig.correctAnswer, ['A']);
  assert.equal(Object.hasOwn(questionWithoutKey.responseConfig, 'correctAnswer'), false);
});

test('mapSnapshotToViewerPayload preserves valid responseConfig.correctAnswer', () => {
  const draft = buildDraft();
  const snapshot = mapDraftToSnapshot(draft, {
    worksheetId: 'ws_1',
    snapshotId: 'snap_1',
    schemaVersion: 1,
    snapshotVersion: 1,
    publishedAt: '2026-03-29T00:00:00Z',
    publishedByUserId: 'user_1',
    sourceDraftRevision: 'rev_1',
  });

  const viewerPayload = mapSnapshotToViewerPayload(snapshot);
  const questionWithKey = viewerPayload.blocks.find((block) => block.blockId === 'q_key');
  const questionWithoutKey = viewerPayload.blocks.find((block) => block.blockId === 'q_no_key');
  assert.deepEqual(questionWithKey.responseConfig.correctAnswer, ['A']);
  assert.equal(Object.hasOwn(questionWithoutKey.responseConfig, 'correctAnswer'), false);
});
