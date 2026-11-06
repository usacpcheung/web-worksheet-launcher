import { hasImageResponses, assertImageQuestions, assertImageAnswers, ATTEMPT_BYTES } from '../image-response.js';
import { assertPackageAssets } from './package-assets.js';
import { hasOptionImages, assertOptionImages } from '../option-images.js';
import { assertWorksheetTextFormats, hasMarkdown } from '../worksheet-text.js';

// Share the package/worksheet boundary. Local readers retain their historical
// envelope defaults and answer coercion; uploads keep the existing strict envelope.
export function assertAttemptPackage(manifest, worksheet, attempt, { allowLegacyEnvelope = false, files } = {}) {
  if (manifest?.format !== 'worksheet-attempt-package' || ![1, 2, 3, 4].includes(manifest.packageVersion)) {
    throw new Error('Unsupported attempt package format/version.');
  }
  if (!Array.isArray(worksheet?.blocks) || worksheet.blocks.length === 0) {
    throw new Error('Attempt worksheet must contain at least one block.');
  }
  assertWorksheetTextFormats(worksheet.blocks);
  assertImageQuestions(worksheet.blocks);
  if (hasImageResponses(worksheet.blocks) && manifest.packageVersion !== 4) throw new Error('Image responses require attempt package version 4.');
  if (hasMarkdown(worksheet.blocks) && manifest.packageVersion < 2) throw new Error('Markdown requires attempt package version 2.');
  if (hasOptionImages(worksheet.blocks) && manifest.packageVersion < 3) throw new Error('Option images require attempt package version 3.');
  if (manifest.packageVersion >= 3) {
    const assets = assertPackageAssets(manifest.assets, files);
    if (manifest.packageVersion === 4) {
      assertImageAnswers(worksheet.blocks, attempt?.answers, assets, files);
      if (files && [...files.values()].reduce((n,b)=>n+b.byteLength,0) > ATTEMPT_BYTES) throw new Error('Attempt exceeds package size limit.');
    }
    // Attempts historically omit kind/usage; option references establish those
    // roles, while the actual MIME type and file bytes are still validated.
    assertOptionImages(worksheet.blocks, new Map([...assets].map(([id, asset]) =>
      [id, { ...asset, kind: 'image', usage: 'option_image' }])));
  }
  // Optional presentation metadata never carries server identity or permissions.
  if (attempt?.metadata !== undefined) {
    const metadata = attempt.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid attempt metadata.');
    for (const key of ['studentName', 'attemptName']) {
      if (metadata[key] !== undefined && typeof metadata[key] !== 'string') throw new Error(`Invalid attempt metadata ${key}.`);
    }
    if (metadata.attemptNameMode !== undefined && !['auto', 'custom'].includes(metadata.attemptNameMode)) throw new Error('Invalid attemptNameMode.');
    if (metadata.studentNameResolved !== undefined && typeof metadata.studentNameResolved !== 'boolean') throw new Error('Invalid studentNameResolved.');
  }
  if (allowLegacyEnvelope && manifest.packageVersion < 4) return;

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
