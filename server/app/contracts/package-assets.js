import { crc32 } from '../../editor/zip-utils.js';

// Strict manifest boundary for the image-capable envelopes (worksheet v4,
// attempt v3). Historical package versions keep their existing readers.
export function assertPackageAssets(assets, files) {
  if (!Array.isArray(assets)) throw new Error('Package assets must be an array.');
  const byId = new Map(), paths = new Set();
  for (const asset of assets) {
    if (!asset || typeof asset.assetId !== 'string' || !asset.assetId.trim()) throw new Error('Invalid package assetId.');
    const path = asset.path;
    if (typeof path !== 'string' || !path.startsWith('media/') || path.includes('..') || path.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Invalid package asset path.');
    }
    if (byId.has(asset.assetId)) throw new Error('Duplicate package assetId.');
    if (paths.has(path)) throw new Error('Duplicate package asset path.');
    paths.add(path);
    if (asset.byteLength != null && (!Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0)) throw new Error('Invalid package asset byteLength.');
    if (asset.crc32 != null && (typeof asset.crc32 !== 'string' || !/^[0-9a-f]{8}$/i.test(asset.crc32))) throw new Error('Invalid package asset CRC32.');
    const bytes = files?.get(path);
    if (files) {
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error('Missing or empty package asset file.');
      if (asset.byteLength != null && asset.byteLength !== bytes.byteLength) throw new Error('Package asset byteLength mismatch.');
      if (asset.crc32 != null && crc32(bytes).toString(16).padStart(8, '0') !== asset.crc32.toLowerCase()) throw new Error('Package asset CRC32 mismatch.');
    }
    byId.set(asset.assetId, { ...asset, ...(files ? { byteLength: bytes.byteLength } : {}) });
  }
  return byId;
}
