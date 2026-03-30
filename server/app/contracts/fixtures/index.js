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
        inputType: 'text',
        maxLength: 240,
        displayMode: 'multi_line',
      },
      draftMeta: {
        isDirty: true,
      },
      localValidation: {
        level: 'warning',
        messages: ['Prompt should mention success criteria.'],
      },
    },
    {
      blockId: 'blk_q_002',
      kind: 'question',
      position: 1,
      prompt: {
        text: 'Enter a score between 0 and 10 in 0.5 increments.',
        format: 'plain_text',
      },
      responseConfig: {
        inputType: 'number',
        min: 0,
        max: 10,
        numberRules: {
          allowedKinds: ['decimal'],
          allowSigned: false,
          decimalPlacesAllowed: 1,
        },
        correctAnswer: 7.5,
      },
    },
    {
      blockId: 'blk_q_003',
      kind: 'question',
      position: 2,
      prompt: {
        text: 'Select all claims supported by evidence.',
        format: 'plain_text',
      },
      responseConfig: {
        inputType: 'multiple_choice',
        selectionMode: 'multi',
        shuffleOptions: true,
        options: [
          { value: 'claim_a', label: 'Claim A' },
          { value: 'claim_b', label: 'Claim B' },
          { value: 'claim_c', label: 'Claim C' },
        ],
        correctAnswer: ['claim_a', 'claim_c'],
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
        inputType: 'text',
        maxLength: 240,
        displayMode: 'multi_line',
      },
    },
    {
      blockId: 'blk_q_002',
      kind: 'question',
      position: 1,
      prompt: {
        text: 'Enter a score between 0 and 10 in 0.5 increments.',
        format: 'plain_text',
      },
      responseConfig: {
        inputType: 'number',
        min: 0,
        max: 10,
        numberRules: {
          allowedKinds: ['decimal'],
          allowSigned: false,
          decimalPlacesAllowed: 1,
        },
        correctAnswer: 7.5,
      },
    },
    {
      blockId: 'blk_q_003',
      kind: 'question',
      position: 2,
      prompt: {
        text: 'Select all claims supported by evidence.',
        format: 'plain_text',
      },
      responseConfig: {
        inputType: 'multiple_choice',
        selectionMode: 'multi',
        shuffleOptions: true,
        options: [
          { value: 'claim_a', label: 'Claim A' },
          { value: 'claim_b', label: 'Claim B' },
          { value: 'claim_c', label: 'Claim C' },
        ],
        correctAnswer: ['claim_a', 'claim_c'],
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
        inputType: 'text',
        maxLength: 240,
        displayMode: 'multi_line',
      },
    },
    {
      blockId: 'blk_q_002',
      kind: 'question',
      position: 1,
      prompt: {
        text: 'Enter a score between 0 and 10 in 0.5 increments.',
        format: 'plain_text',
      },
      responseConfig: {
        inputType: 'number',
        min: 0,
        max: 10,
        numberRules: {
          allowedKinds: ['decimal'],
          allowSigned: false,
          decimalPlacesAllowed: 1,
        },
        correctAnswer: 7.5,
      },
    },
    {
      blockId: 'blk_q_003',
      kind: 'question',
      position: 2,
      prompt: {
        text: 'Select all claims supported by evidence.',
        format: 'plain_text',
      },
      responseConfig: {
        inputType: 'multiple_choice',
        selectionMode: 'multi',
        shuffleOptions: true,
        options: [
          { value: 'claim_a', label: 'Claim A' },
          { value: 'claim_b', label: 'Claim B' },
          { value: 'claim_c', label: 'Claim C' },
        ],
        correctAnswer: ['claim_a', 'claim_c'],
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
      value: 'A stronger claim uses evidence from the passage to support the argument.',
      answeredAt: '2026-03-22T12:14:30Z',
    },
    blk_q_002: {
      value: 7.5,
      answeredAt: '2026-03-22T12:14:45Z',
    },
    blk_q_003: {
      value: ['claim_a', 'claim_c'],
      answeredAt: '2026-03-22T12:14:55Z',
    },
  },
};

export {
  draftFixture,
  snapshotFixture,
  viewerPayloadFixture,
  attemptPayloadFixture,
};
