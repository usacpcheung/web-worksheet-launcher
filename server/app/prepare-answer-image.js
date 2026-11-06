import { imageHeader, IMAGE_INPUT_BYTES, IMAGE_ANSWER_BYTES } from './image-response.js';
const check = (signal) => {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
};
export async function prepareAnswerImage(file, { signal } = {}) {
  check(signal);
  if (!file || file.size > IMAGE_INPUT_BYTES)
    throw Object.assign(new Error('Image exceeds 10 MB.'), {
      code: 'IMAGE_SIZE',
      size: file?.size,
    });
  if (!['image/jpeg', 'image/png'].includes(file.type))
    throw Object.assign(new Error('Choose JPG or PNG.'), {
      code: 'IMAGE_FORMAT',
    });
  const bytes = new Uint8Array(await file.arrayBuffer());
  check(signal);
  let header;
  try {
    header = imageHeader(bytes);
  } catch (error) {
    error.code ??= 'IMAGE_FORMAT';
    throw error;
  }
  if (header.mime !== file.type)
    throw Object.assign(new Error('Image type mismatch.'), {
      code: 'IMAGE_FORMAT',
    });
  let bitmap;
  try {
    try {
      bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
      });
    } catch (error) {
      throw Object.assign(new Error('This file cannot be decoded as an image.', { cause: error }), {
        code: 'IMAGE_FORMAT',
      });
    }
    check(signal);
    if (file.size <= IMAGE_ANSWER_BYTES) return { blob: file, changed: false };
    const canvas = document.createElement('canvas');
    try {
      for (const edge of [2560, 2200, 1900, 1600]) {
        check(signal);
        const ratio = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
        canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const quality of header.mime === 'image/png' ? [undefined] : [0.85, 0.75, 0.65]) {
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, header.mime, quality));
          check(signal);
          if (blob?.size && blob.size <= IMAGE_ANSWER_BYTES) return { blob, changed: true };
        }
      }
      throw Object.assign(new Error('Unable to prepare a sufficiently detailed image under 2 MB.'), {
        code: 'IMAGE_PREPARATION',
      });
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    bitmap?.close();
  }
}
