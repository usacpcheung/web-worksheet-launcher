import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b]);
const PUBLISHED_BUCKETS = ['published', 'roleplayscene/published'];
const QUARANTINE_BUCKET = 'quarantine';

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

function portablePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
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

  async listPublishedArtifacts() {
    const artifacts = [];
    for (const bucket of PUBLISHED_BUCKETS) {
      const bucketPath = this.resolveAbsolutePath(bucket);
      await this.#collectZipArtifacts(bucketPath, bucket, artifacts);
    }
    return artifacts;
  }

  async statArtifact(artifactPath) {
    const absolutePath = this.resolveAbsolutePath(artifactPath);
    try {
      const stats = await fs.stat(absolutePath);
      return {
        artifactPath: portablePath(artifactPath),
        absolutePath,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime,
        isFile: stats.isFile(),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async moveArtifact({ sourcePath, destinationPath }) {
    this.#assertManagedArtifactPath(sourcePath);
    this.#assertManagedArtifactPath(destinationPath);

    const source = this.resolveAbsolutePath(sourcePath);
    const destination = this.resolveAbsolutePath(destinationPath);
    await fs.mkdir(path.dirname(destination), { recursive: true });

    try {
      await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      await fs.unlink(source);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const [sourceStats, destinationStats] = await Promise.all([
          this.statArtifact(sourcePath),
          this.statArtifact(destinationPath),
        ]);
        if (
          sourceStats?.isFile
          && destinationStats?.isFile
          && sourceStats.sizeBytes === destinationStats.sizeBytes
        ) {
          const [sourceHash, destinationHash] = await Promise.all([
            this.#hashFile(source),
            this.#hashFile(destination),
          ]);
          if (sourceHash === destinationHash) {
            await fs.unlink(source);
            return { moved: false, alreadyMoved: true, destinationPath: portablePath(destinationPath) };
          }
        }
      }
      if (error?.code === 'ENOENT') {
        const destinationStats = await this.statArtifact(destinationPath);
        if (destinationStats?.isFile) {
          return { moved: false, alreadyMoved: true, destinationPath: portablePath(destinationPath) };
        }
      }
      throw error;
    }

    return { moved: true, alreadyMoved: false, destinationPath: portablePath(destinationPath) };
  }

  async deleteArtifact(artifactPath) {
    this.#assertManagedArtifactPath(artifactPath);
    const absolutePath = this.resolveAbsolutePath(artifactPath);
    try {
      await fs.unlink(absolutePath);
      return { deleted: true, missing: false };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { deleted: false, missing: true };
      }
      throw error;
    }
  }

  quarantinePath({ artifactKind, quarantineId }) {
    return portablePath(path.join(
      QUARANTINE_BUCKET,
      safeSegment(artifactKind),
      `${safeSegment(quarantineId)}.zip`
    ));
  }

  resolveAbsolutePath(artifactPath) {
    const absolutePath = path.join(this.storageRoot, portablePath(artifactPath));
    const normalized = path.normalize(absolutePath);
    if (!normalized.startsWith(path.normalize(this.storageRoot + path.sep))) {
      throw new Error('Resolved path escapes storage root.');
    }
    return normalized;
  }

  async #collectZipArtifacts(absoluteDirectory, relativeDirectory, output) {
    let entries;
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const absoluteEntry = path.join(absoluteDirectory, entry.name);
      const relativeEntry = portablePath(path.join(relativeDirectory, entry.name));
      if (entry.isDirectory()) {
        await this.#collectZipArtifacts(absoluteEntry, relativeEntry, output);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
        const stats = await fs.stat(absoluteEntry);
        output.push({
          artifactPath: relativeEntry,
          absolutePath: absoluteEntry,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime,
        });
      }
    }
  }

  async #hashFile(absolutePath) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = createReadStream(absolutePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return hash.digest('hex');
  }

  #assertManagedArtifactPath(artifactPath) {
    const normalized = portablePath(artifactPath);
    const allowed = [...PUBLISHED_BUCKETS, QUARANTINE_BUCKET].some(
      (bucket) => normalized === bucket || normalized.startsWith(`${bucket}/`)
    );
    if (!allowed) {
      throw new Error(`Artifact path is outside managed published buckets: ${artifactPath}`);
    }
    this.resolveAbsolutePath(normalized);
  }
}
