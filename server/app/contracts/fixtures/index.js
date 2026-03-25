const draftFixture = {
  draftWorksheetId: 'ws_draft_01HXYZ',
  status: 'draft',
  clientRevision: 12,
  title: 'Argument writing practice',
  description: 'Students compare two claims and revise a response.',
  blocks: [
    {
      blockId: 'blk_q_001',
      kind: 'question',
      position: 0,
      prompt: {
        text: 'Read the claim and write a stronger revision.',
        format: 'plain_text',
      },
      responseConfig: {
        inputType: 'rich_text',
        maxLength: 500,
      },
      draftMeta: {
        isDirty: true,
      },
      localValidation: {
        level: 'warning',
        messages: ['Prompt should mention success criteria.'],
      },
    },
  ],
  draftMeta: {
    autosaveState: 'pending',
    unsavedChanges: true,
    editorSessionId: 'sess_abc123',
  },
  uiState: {
    activePanel: 'validation',
  },
};

const snapshotFixture = {
  worksheetId: 'ws_01HXYZ',
  snapshotId: 'wss_01JABC',
  draftWorksheetId: 'ws_draft_01HXYZ',
  schemaVersion: 1,
  snapshotVersion: 3,
  publishedAt: '2026-03-22T12:05:00Z',
  publishedByUserId: 'usr_123',
  sourceDraftRevision: 'serverAssigned.canonicalRevision:42',
  title: 'Argument writing practice',
  description: 'Students compare two claims and revise a response.',
  blocks: [
    {
      blockId: 'blk_q_001',
      kind: 'question',
      position: 0,
      prompt: {
        text: 'Read the claim and write a stronger revision.',
        format: 'plain_text',
      },
      responseConfig: {
        inputType: 'rich_text',
        maxLength: 500,
      },
    },
  ],
  integrity: {
    contentHash: 'sha256:example',
  },
};

const viewerPayloadFixture = {
  worksheetId: 'ws_01HXYZ',
  snapshotId: 'wss_01JABC',
  snapshotVersion: 3,
  title: 'Argument writing practice',
  blocks: [
    {
      blockId: 'blk_q_001',
      kind: 'question',
      position: 0,
      prompt: {
        text: 'Read the claim and write a stronger revision.',
        format: 'plain_text',
      },
      responseConfig: {
        inputType: 'rich_text',
        maxLength: 500,
      },
    },
  ],
};

const attemptPayloadFixture = {
  attemptId: 'att_01JDEF',
  worksheetId: 'ws_01HXYZ',
  snapshotId: 'wss_01JABC',
  snapshotVersion: 3,
  learnerId: 'lrn_456',
  status: 'submitted',
  startedAt: '2026-03-22T12:10:00Z',
  lastSavedAt: '2026-03-22T12:13:00Z',
  submittedAt: '2026-03-22T12:15:00Z',
  answers: {
    blk_q_001: {
      value: {
        text: 'A stronger claim uses evidence from the passage to support the argument.',
      },
      answeredAt: '2026-03-22T12:14:30Z',
    },
  },
};

export {
  draftFixture,
  snapshotFixture,
  viewerPayloadFixture,
  attemptPayloadFixture,
};
