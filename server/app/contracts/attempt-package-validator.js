import { hasOptionImages, assertOptionImages } from '../option-images.js';
import { assertWorksheetTextFormats, hasMarkdown } from '../worksheet-text.js';

// Share the package/worksheet boundary. Local readers retain their historical
// envelope defaults and answer coercion; uploads keep the existing strict envelope.
export function assertAttemptPackage(manifest, worksheet, attempt, { allowLegacyEnvelope = false, files } = {}) {
  if (manifest?.format !== 'worksheet-attempt-package' || ![1, 2, 3].includes(manifest.packageVersion)) {
    throw new Error('Unsupported attempt package format/version.');
  }
  if (!Array.isArray(worksheet?.blocks) || worksheet.blocks.length === 0) {
    throw new Error('Attempt worksheet must contain at least one block.');
  }
  assertWorksheetTextFormats(worksheet.blocks);
  if (hasMarkdown(worksheet.blocks) && manifest.packageVersion < 2) throw new Error('Markdown requires attempt package version 2.');
  if (hasOptionImages(worksheet.blocks) && manifest.packageVersion !== 3) throw new Error('Option images require attempt package version 3.');
  if (manifest.packageVersion === 3) assertOptionImages(worksheet.blocks, new Map((manifest.assets || []).map(asset => [asset.assetId, { ...asset, kind: 'image', usage: 'option_image' }])));
  if (manifest.packageVersion === 3 && files) {
    for (const block of worksheet.blocks) for (const option of block?.responseConfig?.options || []) {
      for (const ref of option?.mediaRefs || []) {
        if (ref.usage !== 'option_image') continue;
        const asset = manifest.assets.find(asset => asset.assetId === ref.assetId);
        const bytes = files.get(asset.path);
        if (!bytes?.length) throw new Error('Missing option image file.');
        if (bytes.length > 8 * 1024 * 1024) throw new Error('Option image exceeds 8 MB.');
        if (asset.byteLength != null && bytes.length !== asset.byteLength) throw new Error('Option image byteLength mismatch.');
      }
    }
  }
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
