import { readZipDirectory, checkZipLimit } from '../../../app/contracts/zip-directory.js';
import { crc32 } from '../../../editor/zip-utils.js';
import { Inflate, strFromU8 } from '../vendor/fflate.module.js';

export const DEFAULT_ROLEPLAYSCENE_PACKAGE_LIMITS = Object.freeze({
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxEntries: 200,
  maxEntryNameLength: 512,
});

// Includes room for headers and DEFLATE overhead on incompressible local media.
export const LOCAL_ARCHIVE_BYTES = 72 * 1024 * 1024;

export function checkSceneExportSizes(entries) {
  const limits = DEFAULT_ROLEPLAYSCENE_PACKAGE_LIMITS;
  checkZipLimit('maxEntries', limits.maxEntries, entries.length);
  let total = 0;
  for (const { path, size } of entries) {
    checkZipLimit('maxEntryNameLength', limits.maxEntryNameLength, path.length, path);
    checkZipLimit('maxEntryBytes', limits.maxEntryBytes, size, path);
    total += size;
    checkZipLimit('maxUncompressedBytes', limits.maxUncompressedBytes, total);
  }
}

// Yield between chunks so the browser can time-slice large successful imports.
// Never hand the inflater a whole untrusted stream with only its declared size.
function* extract(bytes, overrides) {
  const limits = { ...DEFAULT_ROLEPLAYSCENE_PACKAGE_LIMITS, ...overrides };
  const legacyNames = new Map();
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const entries = readZipDirectory(bytes, {
    allowDeflate: true, limits,
    decodeName(raw, utf8) {
      const name = strFromU8(raw, !utf8);
      if (!utf8 && raw.some(byte => byte >= 128)) {
        // Some historical server copies wrote UTF-8 names without the flag.
        // A genuine single-byte name remains authoritative unless the project
        // explicitly references only its alternate spelling.
        try {
          legacyNames.set(name, utf8Decoder.decode(raw));
        } catch { /* Single-byte filename with no UTF-8 interpretation. */ }
      }
      return name;
    },
  });
  const files = new Map();
  for (const entry of entries) {
    const input = bytes.subarray(entry.dataStart, entry.dataEnd);
    let output = input;
    if (entry.method === 8) {
      output = new Uint8Array(entry.size);
      let written = 0;
      const inflater = new Inflate(chunk => {
        if (chunk.length > output.length - written) throw new Error('Invalid ZIP: decompressed entry exceeds declared size.');
        output.set(chunk, written);
        written += chunk.length;
      });
      if (!input.length) throw new Error('Invalid ZIP: missing compressed data.');
      const step = 4096;
      for (let pos = 0; pos < input.length; pos += step) {
        const lastChunk = pos + step >= input.length;
        inflater.push(input.subarray(pos, pos + step), lastChunk);
        // In the bundled fflate, f marks the final block; l is cleared when
        // its end is decoded. p retains the partly consumed byte (if any).
        const ended = inflater.s.f && !inflater.s.l;
        if (ended && (!lastChunk || inflater.p.length > Math.ceil(inflater.s.p / 8))) {
          throw new Error('Invalid ZIP: trailing compressed data.');
        }
        if (lastChunk && !ended) throw new Error('Invalid ZIP: incomplete DEFLATE stream.');
        yield;
      }
      if (written !== entry.size) throw new Error('Invalid ZIP: incomplete entry.');
    }
    if (crc32(output) !== entry.checksum) throw new Error('Invalid ZIP: entry checksum mismatch.');
    files.set(entry.name, output);
    yield;
  }
  return { files, legacyNames };
}

export function readSceneArchiveSync(bytes, limits) {
  const work = extract(bytes, limits);
  let result = work.next();
  while (!result.done) result = work.next();
  return result.value;
}

export async function readLocalSceneArchive(file) {
  checkZipLimit('archive bytes', LOCAL_ARCHIVE_BYTES, file.size ?? file.byteLength);
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  checkZipLimit('archive bytes', LOCAL_ARCHIVE_BYTES, bytes.byteLength);
  const work = extract(bytes);
  let deadline = performance.now() + 12;
  for (let result = work.next(); ; result = work.next()) {
    if (result.done) return result.value;
    if (performance.now() >= deadline) {
      await new Promise(resolve => setTimeout(resolve, 0));
      deadline = performance.now() + 12;
    }
  }
}

export function sceneMediaPaths(project, manifest) {
  const paths = new Set();
  function add(asset) {
    if (typeof asset?.path === 'string' && asset.path.trim()) paths.add(asset.path);
  }
  if (Array.isArray(manifest?.assets)) manifest.assets.forEach(add);
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    add(scene?.image);
    add(scene?.backgroundAudio);
    for (const line of Array.isArray(scene?.dialogue) ? scene.dialogue : []) add(line?.audio);
  }
  return paths;
}

// Preserve exact ZIP names, including meaningful spaces. Some old JSON
// references have surrounding whitespace and the API accepted them trimmed.
export function sceneMediaPath(files, path) {
  return files.has(path) || typeof path !== 'string' ? path : path.trim();
}

export function resolveLegacySceneNames({ files, legacyNames }, paths) {
  if (!legacyNames.size) return;
  const referenced = new Set(paths);
  for (const path of paths) referenced.add(sceneMediaPath(files, path));
  for (const [name, alternate] of legacyNames) {
    if (referenced.has(alternate) && !referenced.has(name) && !files.has(alternate)) {
      files.set(alternate, files.get(name));
      files.delete(name);
    }
  }
}
