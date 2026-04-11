import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b]);

function ensureZipBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error('Artifact body must be a non-empty ZIP file.');
  }
  if (buffer[0] !== ZIP_MAGIC[0] || buffer[1] !== ZIP_MAGIC[1]) {
    throw new Error('Artifact body is not a ZIP payload (missing PK signature).');
  }
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class PackageArtifactStore {
  constructor({ storageRoot }) {
    this.storageRoot = storageRoot;
  }

  async storeArtifact({ ownerSub, bucket, artifactId, bytes }) {
    ensureZipBuffer(bytes);

    const ownerSegment = safeSegment(ownerSub);
    const relativePath = path.join(bucket, ownerSegment, `${artifactId}.zip`);
    const absolutePath = path.join(this.storageRoot, relativePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, bytes, { flag: 'wx' });

    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    return {
      artifactPath: relativePath,
      artifactSha256: sha256,
      artifactSizeBytes: bytes.byteLength,
      absolutePath,
    };
  }

  async readArtifact(artifactPath) {
    const normalized = this.resolveAbsolutePath(artifactPath);
    return fs.readFile(normalized);
  }

  resolveAbsolutePath(artifactPath) {
    const absolutePath = path.join(this.storageRoot, artifactPath);
    const normalized = path.normalize(absolutePath);
    if (!normalized.startsWith(path.normalize(this.storageRoot + path.sep))) {
      throw new Error('Resolved path escapes storage root.');
    }
    return normalized;
  }
}
