import { assertWorksheetTextFormats, hasMarkdown } from '../worksheet-text.js';

// Share the package/worksheet boundary. Local readers retain their historical
// envelope defaults and answer coercion; uploads keep the existing strict envelope.
export function assertAttemptPackage(manifest, worksheet, attempt, { allowLegacyEnvelope = false } = {}) {
  if (manifest?.format !== 'worksheet-attempt-package' || ![1, 2].includes(manifest.packageVersion)) {
    throw new Error('Unsupported attempt package format/version.');
  }
  if (!Array.isArray(worksheet?.blocks) || worksheet.blocks.length === 0) {
    throw new Error('Attempt worksheet must contain at least one block.');
  }
  assertWorksheetTextFormats(worksheet.blocks);
  if (hasMarkdown(worksheet.blocks) && manifest.packageVersion !== 2) throw new Error('Markdown requires attempt package version 2.');
  if (allowLegacyEnvelope) return;

  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) throw new Error('Unsupported manifest schemaVersion.');
  if (attempt?.schemaVersion !== 1 || attempt?.kind !== 'worksheet-attempt') throw new Error('Unsupported attempt schema.');
  if (!['in_progress', 'submitted', 'checked'].includes(attempt.status)) throw new Error('Invalid attempt status.');
  if (!attempt.answers || typeof attempt.answers !== 'object' || Array.isArray(attempt.answers)) throw new Error('answers must be an object.');
  if (attempt.status !== 'in_progress' && !attempt.submittedAt) throw new Error('submittedAt required.');
  const ids = new Set(worksheet.blocks.map(block => {
    const id = typeof block?.blockId === 'string' ? block.blockId.trim() : '';
    return id || (typeof block?.id === 'string' ? block.id.trim() : '');
  }).filter(Boolean));
  if (attempt.checking?.items && typeof attempt.checking.items === 'object') {
    for (const id of Object.keys(attempt.checking.items)) {
      if (!ids.has(id)) throw new Error(`checking item references unknown blockId: ${id}`);
    }
  }
}
