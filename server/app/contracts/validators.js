function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

function validateBlocks(blocks, path, errors) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }

  blocks.forEach((block, index) => {
    const blockPath = `${path}[${index}]`;
    if (!isObject(block)) {
      errors.push(`${blockPath} must be an object`);
      return;
    }

    if (!isNonEmptyString(block.blockId)) {
      errors.push(`${blockPath}.blockId must be a non-empty string`);
    }
    if (!isNonEmptyString(block.kind)) {
      errors.push(`${blockPath}.kind must be a non-empty string`);
    }
    if (!Number.isInteger(block.position) || block.position < 0) {
      errors.push(`${blockPath}.position must be a non-negative integer`);
    }

    if (block.kind === 'question') {
      if (!isObject(block.prompt) || !isNonEmptyString(block.prompt.text)) {
        errors.push(`${blockPath}.prompt.text is required for question blocks`);
      }
      if (!isObject(block.responseConfig)) {
        errors.push(`${blockPath}.responseConfig is required for question blocks`);
      }
    }

    if (block.kind === 'content') {
      if (!isObject(block.content) || !isNonEmptyString(block.content.text)) {
        errors.push(`${blockPath}.content.text is required for content blocks`);
      }
    }
  });
}

function validateDraftSchema(draft) {
  const errors = [];

  if (!isObject(draft)) {
    return { valid: false, errors: ['draft must be a non-null object'] };
  }

  if (!isNonEmptyString(draft.draftWorksheetId)) {
    errors.push('draft.draftWorksheetId must be a non-empty string');
  }

  if (!isNonEmptyString(draft.title)) {
    errors.push('draft.title must be a non-empty string');
  }

  if (draft.description !== undefined && typeof draft.description !== 'string') {
    errors.push('draft.description must be a string when provided');
  }

  validateBlocks(draft.blocks, 'draft.blocks', errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateSnapshotSchema(snapshot) {
  const errors = [];

  if (!isObject(snapshot)) {
    return { valid: false, errors: ['snapshot must be a non-null object'] };
  }

  ['worksheetId', 'snapshotId', 'draftWorksheetId', 'title'].forEach((field) => {
    if (!isNonEmptyString(snapshot[field])) {
      errors.push(`snapshot.${field} must be a non-empty string`);
    }
  });

  if (!Number.isInteger(snapshot.schemaVersion) || snapshot.schemaVersion < 1) {
    errors.push('snapshot.schemaVersion must be a positive integer');
  }

  if (!Number.isInteger(snapshot.snapshotVersion) || snapshot.snapshotVersion < 1) {
    errors.push('snapshot.snapshotVersion must be a positive integer');
  }

  if (!isIsoTimestamp(snapshot.publishedAt)) {
    errors.push('snapshot.publishedAt must be an ISO-8601 timestamp string');
  }

  if (!isNonEmptyString(snapshot.publishedByUserId)) {
    errors.push('snapshot.publishedByUserId must be a non-empty string');
  }

  validateBlocks(snapshot.blocks, 'snapshot.blocks', errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateViewerPayloadSchema(viewerPayload) {
  const errors = [];

  if (!isObject(viewerPayload)) {
    return { valid: false, errors: ['viewerPayload must be a non-null object'] };
  }

  ['worksheetId', 'snapshotId', 'title'].forEach((field) => {
    if (!isNonEmptyString(viewerPayload[field])) {
      errors.push(`viewerPayload.${field} must be a non-empty string`);
    }
  });

  if (
    viewerPayload.snapshotVersion !== undefined
    && (!Number.isInteger(viewerPayload.snapshotVersion) || viewerPayload.snapshotVersion < 1)
  ) {
    errors.push('viewerPayload.snapshotVersion must be a positive integer when provided');
  }

  validateBlocks(viewerPayload.blocks, 'viewerPayload.blocks', errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateAttemptPayloadSchema(attemptPayload) {
  const errors = [];

  if (!isObject(attemptPayload)) {
    return { valid: false, errors: ['attemptPayload must be a non-null object'] };
  }

  ['attemptId', 'worksheetId', 'snapshotId', 'learnerId', 'status'].forEach((field) => {
    if (!isNonEmptyString(attemptPayload[field])) {
      errors.push(`attemptPayload.${field} must be a non-empty string`);
    }
  });

  if (
    attemptPayload.snapshotVersion !== undefined
    && (!Number.isInteger(attemptPayload.snapshotVersion) || attemptPayload.snapshotVersion < 1)
  ) {
    errors.push('attemptPayload.snapshotVersion must be a positive integer when provided');
  }

  ['startedAt', 'lastSavedAt', 'submittedAt'].forEach((field) => {
    if (attemptPayload[field] !== undefined && !isIsoTimestamp(attemptPayload[field])) {
      errors.push(`attemptPayload.${field} must be an ISO-8601 timestamp when provided`);
    }
  });

  if (!isObject(attemptPayload.answers)) {
    errors.push('attemptPayload.answers must be an object map keyed by question blockId');
  } else {
    Object.entries(attemptPayload.answers).forEach(([blockId, answer]) => {
      if (!isObject(answer)) {
        errors.push(`attemptPayload.answers.${blockId} must be an object`);
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(answer, 'value')) {
        errors.push(`attemptPayload.answers.${blockId}.value is required`);
      }
      if (answer.answeredAt !== undefined && !isIsoTimestamp(answer.answeredAt)) {
        errors.push(`attemptPayload.answers.${blockId}.answeredAt must be an ISO-8601 timestamp when provided`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export {
  validateDraftSchema,
  validateSnapshotSchema,
  validateViewerPayloadSchema,
  validateAttemptPayloadSchema,
};
