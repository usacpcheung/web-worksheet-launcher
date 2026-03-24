import {
  validateDraftSchema,
  validateSnapshotSchema,
  validateViewerPayloadSchema,
} from './validators.js';

function sortBlocksByPosition(blocks) {
  return [...blocks].sort((a, b) => a.position - b.position);
}

function sanitizeDraftBlockForSnapshot(block) {
  const base = {
    blockId: block.blockId,
    kind: block.kind,
    position: block.position,
  };

  if (block.prompt) {
    base.prompt = block.prompt;
  }
  if (block.content) {
    base.content = block.content;
  }
  if (block.responseConfig) {
    base.responseConfig = block.responseConfig;
  }

  return base;
}

function mapDraftToSnapshot(draft, publishMetadata) {
  const validation = validateDraftSchema(draft);
  if (!validation.valid) {
    throw new Error(`Cannot map draft -> snapshot: ${validation.errors.join('; ')}`);
  }

  const requiredMetadataFields = [
    'worksheetId',
    'snapshotId',
    'schemaVersion',
    'snapshotVersion',
    'publishedAt',
    'publishedByUserId',
    'sourceDraftRevision',
  ];

  for (const field of requiredMetadataFields) {
    if (publishMetadata?.[field] === undefined || publishMetadata?.[field] === null) {
      throw new Error(`Cannot map draft -> snapshot: publishMetadata.${field} is required`);
    }
  }

  return {
    worksheetId: publishMetadata.worksheetId,
    snapshotId: publishMetadata.snapshotId,
    draftWorksheetId: draft.draftWorksheetId,
    schemaVersion: publishMetadata.schemaVersion,
    snapshotVersion: publishMetadata.snapshotVersion,
    publishedAt: publishMetadata.publishedAt,
    publishedByUserId: publishMetadata.publishedByUserId,
    sourceDraftRevision: publishMetadata.sourceDraftRevision,
    title: draft.title,
    description: draft.description || '',
    blocks: sortBlocksByPosition(draft.blocks).map(sanitizeDraftBlockForSnapshot),
    integrity: publishMetadata.integrity || null,
  };
}

function sanitizeSnapshotBlockForViewer(block) {
  const base = {
    blockId: block.blockId,
    kind: block.kind,
    position: block.position,
  };

  if (block.prompt) {
    base.prompt = block.prompt;
  }
  if (block.content) {
    base.content = block.content;
  }
  if (block.responseConfig) {
    base.responseConfig = block.responseConfig;
  }

  return base;
}

function mapSnapshotToViewerPayload(snapshot) {
  const validation = validateSnapshotSchema(snapshot);
  if (!validation.valid) {
    throw new Error(`Cannot map snapshot -> viewer payload: ${validation.errors.join('; ')}`);
  }

  return {
    worksheetId: snapshot.worksheetId,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.snapshotVersion,
    title: snapshot.title,
    blocks: sortBlocksByPosition(snapshot.blocks).map(sanitizeSnapshotBlockForViewer),
  };
}

function mapViewerPayloadAndResponsesToAttempt(viewerPayload, userResponses, attemptMetadata) {
  const validation = validateViewerPayloadSchema(viewerPayload);
  if (!validation.valid) {
    throw new Error(`Cannot map viewer payload + responses -> attempt: ${validation.errors.join('; ')}`);
  }

  const questionBlockIds = new Set(
    viewerPayload.blocks
      .filter((block) => block.kind === 'question')
      .map((block) => block.blockId)
  );

  const sanitizedAnswers = {};

  if (!attemptMetadata || typeof attemptMetadata !== 'object') {
    throw new Error('Cannot map viewer payload + responses -> attempt: attemptMetadata is required');
  }
  if (!attemptMetadata.attemptId) {
    throw new Error('Cannot map viewer payload + responses -> attempt: attemptMetadata.attemptId is required');
  }
  if (!attemptMetadata.learnerId) {
    throw new Error('Cannot map viewer payload + responses -> attempt: attemptMetadata.learnerId is required');
  }

  if (userResponses && typeof userResponses === 'object') {
    Object.entries(userResponses).forEach(([blockId, answer]) => {
      if (!questionBlockIds.has(blockId)) {
        return;
      }

      if (answer && typeof answer === 'object' && Object.prototype.hasOwnProperty.call(answer, 'value')) {
        sanitizedAnswers[blockId] = {
          value: answer.value,
          ...(answer.answeredAt ? { answeredAt: answer.answeredAt } : {}),
        };
        return;
      }

      sanitizedAnswers[blockId] = {
        value: answer,
      };
    });
  }

  return {
    attemptId: attemptMetadata.attemptId,
    worksheetId: viewerPayload.worksheetId,
    snapshotId: viewerPayload.snapshotId,
    ...(viewerPayload.snapshotVersion ? { snapshotVersion: viewerPayload.snapshotVersion } : {}),
    learnerId: attemptMetadata.learnerId,
    status: attemptMetadata.status || 'in_progress',
    startedAt: attemptMetadata.startedAt,
    lastSavedAt: attemptMetadata.lastSavedAt,
    submittedAt: attemptMetadata.submittedAt,
    answers: sanitizedAnswers,
  };
}

export {
  mapDraftToSnapshot,
  mapSnapshotToViewerPayload,
  mapViewerPayloadAndResponsesToAttempt,
};
