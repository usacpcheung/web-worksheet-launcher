import { isFillInBlanks, blankDefinitions, BLANK_LIMIT } from './fill-in-blanks.js';
import { isLongText, LONG_TEXT_LIMIT } from './text-answer.js';
// Browser/server contract. Limits are bytes (MiB), consistently displayed as MB.
export const IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
export const IMAGE_ANSWER_BYTES = 2 * 1024 * 1024;
export const ATTEMPT_BYTES = 30 * 1024 * 1024;
export const ATTEMPT_OVERHEAD_BYTES = 1024 * 1024;
export const IMAGE_MAX_PIXELS = 24_000_000;
export const IMAGE_MAX_SIDE = 8192;
export const imageQuestions = (blocks) =>
  (blocks || []).filter((b) => b?.responseConfig?.inputType === 'image_response');
export const hasImageResponses = (blocks) => imageQuestions(blocks).length > 0;
export function assertImageQuestions(blocks) {
  const questions = imageQuestions(blocks);
  if (questions.length > 3) throw new Error('A worksheet supports at most 3 image-response questions.');
  for (const q of questions) {
    if (q.kind !== 'question') throw new Error('Image response must be a question.');
    const max = q.responseConfig.maxImages;
    if (!Number.isInteger(max) || max < 1 || max > 3)
      throw new Error('Maximum answer images must be 1, 2 or 3.');
    if (q.responseConfig.correctAnswer !== undefined)
      throw new Error('Image responses do not support automatic answer keys.');
  }
}
export function imageBudget(blocks, mediaBytes, contentBytes = 0) {
  const reserved = imageQuestions(blocks).reduce(
    (n, q) => n + q.responseConfig.maxImages * IMAGE_ANSWER_BYTES,
    0
  );
  const answerText = (blocks || []).reduce((n, b) => {
    const c = b?.responseConfig;
    if (!c || c.inputType === 'image_response') return n;
    if (isFillInBlanks(c))
      return n + blankDefinitions(c).reduce((sum, blank) => sum + BLANK_LIMIT * 6 + blank.id.length * 6 + 8, 0);
    if (c.inputType === 'text')
      return (
        n +
        (Number.isFinite(c.maxLength) && c.maxLength > 0
          ? c.maxLength
          : c.maxLength == null
            ? (isLongText(c) ? LONG_TEXT_LIMIT : 200)
            : Infinity) *
          6
      );
    if (c.inputType === 'multiple_choice')
      return n + (c.options || []).reduce((sum, o) => sum + String(o?.value ?? o?.label ?? '').length * 6, 0);
    return n + 64;
  }, 0);
  const total = mediaBytes + contentBytes + reserved + answerText + ATTEMPT_OVERHEAD_BYTES;
  return {
    reserved,
    total,
    limit: ATTEMPT_BYTES,
    ok: Number.isFinite(total) && total <= ATTEMPT_BYTES,
  };
}
export function assertImageBudget(blocks, assets, contentBytes = 0) {
  assertImageQuestions(blocks);
  if (!hasImageResponses(blocks)) return;
  const budget = imageBudget(
    blocks,
    assets.reduce((n, a) => n + (a.byteLength || a.binary?.byteLength || 0), 0),
    contentBytes
  );
  if (!budget.ok)
    throw Object.assign(
      new Error(
        'Worksheet media and maximum image answers exceed the 30 MB package budget. Reduce worksheet media or image counts.'
      ),
      { code: 'IMAGE_PACKAGE_BUDGET' }
    );
}
export function imageAnswerRefs(value, max = 3) {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid image answer count.');
  const seen = new Set();
  for (const ref of value) {
    if (!ref || typeof ref.assetId !== 'string' || !ref.assetId.trim() || seen.has(ref.assetId))
      throw new Error('Invalid or duplicate answer image reference.');
    seen.add(ref.assetId);
  }
  return value.map((ref) => ({ assetId: ref.assetId }));
}
export function imageHeader(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Invalid image bytes.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, mime;
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => bytes[i] === x)) {
    if (v.getUint32(8) !== 13 || v.getUint32(12) !== 0x49484452) throw new Error('Invalid PNG header.');
    width = v.getUint32(16);
    height = v.getUint32(20);
    mime = 'image/png';
    // Reject animation and truncated chunks; no decode/allocation is needed.
    let pos = 8,
      ended = false;
    while (pos + 12 <= bytes.length) {
      const len = v.getUint32(pos),
        type = v.getUint32(pos + 4);
      if (len > bytes.length - pos - 12) throw new Error('Truncated PNG.');
      if (type === 0x6163544c) throw new Error('Animated PNG is not supported.');
      pos += len + 12;
      if (type === 0x49454e44) {
        ended = true;
        break;
      }
    }
    if (!ended) throw new Error('Incomplete PNG.');
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg';
    let p = 2;
    let ended = false;
    for (let i = 2; i < bytes.length - 1; i++) {
      if (bytes[i] === 255 && bytes[i + 1] === 217) {
        ended = true;
        break;
      }
    }
    if (!ended) throw new Error('Incomplete JPEG.');
    while (p + 3 < bytes.length) {
      if (bytes[p++] !== 255) throw new Error('Invalid JPEG marker.');
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > bytes.length) break;
      const len = v.getUint16(p);
      if (len < 2 || p + len > bytes.length) throw new Error('Truncated JPEG.');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (len < 8) throw new Error('Invalid JPEG frame.');
        height = v.getUint16(p + 3);
        width = v.getUint16(p + 5);
        break;
      }
      p += len;
    }
  } else throw new Error('Choose a JPG or PNG image.');
  if (!width || !height) throw new Error('Unreadable image dimensions.');
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE || width * height > IMAGE_MAX_PIXELS)
    throw Object.assign(
      new Error(`Image dimensions ${width} × ${height} exceed 24 megapixels or 8192 pixels per side.`),
      { code: 'IMAGE_DIMENSIONS', width, height }
    );
  return { width, height, mime };
}
export function assertImageAnswers(blocks, answers, assets, files) {
  assertImageQuestions(blocks);
  for (const q of imageQuestions(blocks)) {
    const value = answers?.[q.blockId ?? q.id]?.value;
    if (value === undefined) continue;
    for (const ref of imageAnswerRefs(value, q.responseConfig.maxImages)) {
      const a = assets.get(ref.assetId),
        bytes = a && files?.get(a.path);
      if (!a || !bytes || bytes.byteLength > IMAGE_ANSWER_BYTES)
        throw new Error('Missing or oversized answer image.');
      const header = imageHeader(bytes);
      if (a.mimeType !== header.mime) throw new Error('Answer image MIME does not match its bytes.');
    }
  }
}
