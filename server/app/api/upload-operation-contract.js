// The transport metadata is fingerprinted exactly, before service normalization.
export function uploadFingerprintInput(kind, metadata, packageSha256) {
  return JSON.stringify([kind, metadata.map(value => String(value ?? '')), packageSha256]);
}

export async function hashUploadRequest(kind, metadata, bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const hex = buffer => [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
  const data = typeof Blob === 'function' && bytes instanceof Blob ? await bytes.arrayBuffer() : bytes;
  const packageHash = hex(await crypto.subtle.digest('SHA-256', data));
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uploadFingerprintInput(kind, metadata, packageHash))));
}
