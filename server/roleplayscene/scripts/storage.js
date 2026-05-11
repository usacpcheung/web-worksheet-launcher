import { createProject, createScene, SceneType } from './model.js';
import { zip, unzip } from './utils/zip.js';
import { seedIdSequencesFromProject } from './utils/id.js';
import { validateProject } from './editor/validators.js';

const DB_NAME = 'roleplayscene';
const DB_VERSION = 1;
const PROJECT_STORE = 'project';
const PROJECT_KEY = 'snapshot';
const SAVE_DEBOUNCE_MS = 500;
const ARCHIVE_MANIFEST_VERSION = 1;

export const ImportErrorCode = Object.freeze({
  INVALID_ZIP: 'invalid_zip',
  MISSING_PROJECT_JSON: 'missing_project_json',
  INVALID_JSON: 'invalid_json',
  INVALID_PROJECT: 'invalid_project',
});

export class ProjectImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectImportError';
    this.code = code;
    this.errors = Array.isArray(details.errors) ? details.errors : [];
    this.warnings = Array.isArray(details.warnings) ? details.warnings : [];
  }
}

function noop() {}

function isIndexedDBAvailable() {
  return typeof globalThis !== 'undefined'
    && typeof globalThis.indexedDB !== 'undefined';
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE);
      }
    };
    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB'));
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function withStore(db, mode, fn) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(PROJECT_STORE, mode);
      const store = tx.objectStore(PROJECT_STORE);
      const request = fn(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    } catch (err) {
      reject(err);
    }
  });
}

function readSnapshot(db) {
  return withStore(db, 'readonly', store => store.get(PROJECT_KEY));
}

function writeSnapshot(db, data) {
  return withStore(db, 'readwrite', store => store.put(data, PROJECT_KEY));
}

function safeCreateObjectURL(blob) {
  if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  try {
    return URL.createObjectURL(blob);
  } catch (err) {
    console.warn('Failed to create object URL from blob', err);
    return null;
  }
}

function safeRevokeObjectURL(url) {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return;
  }
  try {
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn('Failed to revoke object URL', err);
  }
}

function sanitizeFilename(name, fallback) {
  const fallbackValue = fallback || 'roleplay';
  if (!name) return fallbackValue;
  const trimmed = String(name).trim();
  if (!trimmed) return fallbackValue;
  const safe = trimmed
    .replace(/[\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-');
  return safe.slice(0, 128) || fallbackValue;
}

function sanitizePathSegment(segment, fallback) {
  const fallbackValue = fallback || 'item';
  if (!segment) return fallbackValue;
  const safe = String(segment)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return safe || fallbackValue;
}

function getExtension(name) {
  if (!name) return '';
  const index = String(name).lastIndexOf('.');
  if (index === -1) return '';
  return String(name).slice(index);
}

function ensureUniquePath(basePath, used) {
  let candidate = basePath;
  let counter = 1;
  while (used.has(candidate)) {
    const lastSlash = basePath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? basePath.slice(0, lastSlash + 1) : '';
    const file = lastSlash >= 0 ? basePath.slice(lastSlash + 1) : basePath;
    const dotIndex = file.lastIndexOf('.');
    const name = dotIndex >= 0 ? file.slice(0, dotIndex) : file;
    const ext = dotIndex >= 0 ? file.slice(dotIndex) : '';
    candidate = `${dir}${name}-${counter}${ext}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function collectAsset({
  asset,
  sceneId,
  sceneIndex,
  kind,
  itemIndex = null,
  usedPaths,
  binaries,
}) {
  if (!asset) return null;
  const name = asset.name ?? '';
  const blob = asset.blob ?? null;
  if (!blob) {
    return { name, type: '', size: 0, path: null };
  }
  const sceneSegment = sanitizePathSegment(sceneId, `scene-${sceneIndex + 1}`);
  const baseName = itemIndex == null ? kind : `${kind}-${itemIndex + 1}`;
  const ext = getExtension(name) || '.bin';
  const basePath = `media/${sceneSegment}/${baseName}${ext}`;
  const path = ensureUniquePath(basePath, usedPaths);
  binaries.push({ path, blob });
  const type = blob.type || 'application/octet-stream';
  const size = typeof blob.size === 'number' ? blob.size : 0;
  return { name, type, size, path };
}

function buildManifest(snapshot) {
  if (!snapshot) return { manifest: null, binaries: [] };
  const binaries = [];
  const usedPaths = new Set();
  const manifest = {
    meta: { ...snapshot.meta },
    scenes: snapshot.scenes.map((scene, sceneIndex) => {
      const sceneId = scene.id || `scene-${sceneIndex + 1}`;
      const dialogue = Array.isArray(scene.dialogue) ? scene.dialogue : [];
      return {
        id: scene.id,
        type: scene.type,
        image: collectAsset({
          asset: scene.image,
          sceneId,
          sceneIndex,
          kind: 'image',
          usedPaths,
          binaries,
        }),
        backgroundAudio: collectAsset({
          asset: scene.backgroundAudio,
          sceneId,
          sceneIndex,
          kind: 'background',
          usedPaths,
          binaries,
        }),
        dialogue: dialogue.map((line, lineIndex) => ({
          text: line.text ?? '',
          audio: collectAsset({
            asset: line.audio,
            sceneId,
            sceneIndex,
            kind: 'dialogue',
            itemIndex: lineIndex,
            usedPaths,
            binaries,
          }),
        })),
        choices: Array.isArray(scene.choices)
          ? scene.choices.map(choice => ({
              id: choice.id,
              label: choice.label,
              nextSceneId: choice.nextSceneId ?? null,
              cueCardText: choice.cueCardText ?? '',
            }))
          : [],
        autoNextSceneId: scene.autoNextSceneId ?? null,
        notes: scene.notes ?? '',
      };
    }),
    assets: Array.isArray(snapshot.assets) ? snapshot.assets.slice() : [],
  };
  return { manifest, binaries };
}

function restoreAsset(manifestAsset, files, warnings) {
  if (!manifestAsset) return null;
  const name = manifestAsset.name ?? '';
  const path = manifestAsset.path ?? null;
  if (path && files[path]) {
    const type = manifestAsset.type || 'application/octet-stream';
    const blob = new Blob([files[path]], { type });
    return { name, blob };
  }
  if (path && warnings) {
    warnings.push(path);
  }
  return { name, blob: null };
}

function manifestToSerialized(manifest, files, warnings = []) {
  if (!manifest) return null;
  const scenes = Array.isArray(manifest.scenes) ? manifest.scenes.slice(0, 20) : [];
  return {
    meta: { ...manifest.meta },
    scenes: scenes.map(scene => {
      const dialogue = Array.isArray(scene.dialogue) ? scene.dialogue : [];
      return {
        id: scene.id,
        type: scene.type,
        image: restoreAsset(scene.image, files, warnings),
        backgroundAudio: restoreAsset(scene.backgroundAudio, files, warnings),
        dialogue: dialogue.map(line => ({
          text: line.text ?? '',
          audio: restoreAsset(line.audio, files, warnings),
        })),
        choices: Array.isArray(scene.choices)
          ? scene.choices.map(choice => ({
              id: choice.id,
              label: choice.label,
              nextSceneId: choice.nextSceneId ?? null,
              cueCardText: choice.cueCardText ?? '',
            }))
          : [],
        autoNextSceneId: scene.autoNextSceneId ?? null,
        notes: scene.notes ?? '',
      };
    }),
    assets: Array.isArray(manifest.assets) ? manifest.assets.slice() : [],
  };
}

export async function createProjectArchive(project) {
  if (!project) {
    throw new Error('Cannot export empty project');
  }
  const snapshot = serializeProject(project);
  if (!snapshot) {
    throw new Error('Failed to serialise project');
  }
  const { manifest, binaries } = buildManifest(snapshot);
  const encoder = new TextEncoder();
  const payload = {
    manifestVersion: ARCHIVE_MANIFEST_VERSION,
    project: manifest,
  };
  const entries = {
    'project.json': encoder.encode(JSON.stringify(payload, null, 2)),
  };
  for (const { path, blob } of binaries) {
    const buffer = await blob.arrayBuffer();
    entries[path] = new Uint8Array(buffer);
  }
  const archiveData = await zip(entries);
  return { archiveData, payload };
}

export function revokeProjectObjectUrls(project) {
  if (!project || !Array.isArray(project.scenes)) return;
  project.scenes.forEach(scene => {
    if (scene.image?.objectUrl) {
      safeRevokeObjectURL(scene.image.objectUrl);
    }
    if (scene.backgroundAudio?.objectUrl) {
      safeRevokeObjectURL(scene.backgroundAudio.objectUrl);
    }
    if (Array.isArray(scene.dialogue)) {
      scene.dialogue.forEach(line => {
        if (line.audio?.objectUrl) {
          safeRevokeObjectURL(line.audio.objectUrl);
        }
      });
    }
  });
}

export function serializeProject(project) {
  if (!project) return null;
  const scenes = Array.isArray(project.scenes) ? project.scenes.slice(0, 20) : [];
  return {
    meta: { ...project.meta },
    scenes: scenes.map(scene => {
      const dialogue = Array.isArray(scene.dialogue) ? scene.dialogue : [];
      const choices = Array.isArray(scene.choices) ? scene.choices : [];
      return {
        id: scene.id,
        type: scene.type,
        image: scene.image ? { name: scene.image.name ?? '', blob: scene.image.blob ?? null } : null,
        backgroundAudio: scene.backgroundAudio
          ? { name: scene.backgroundAudio.name ?? '', blob: scene.backgroundAudio.blob ?? null }
          : null,
        dialogue: dialogue.map(line => ({
          text: line.text ?? '',
          audio: line.audio
            ? { name: line.audio.name ?? '', blob: line.audio.blob ?? null }
            : null,
        })),
        choices: choices.map(choice => ({
          id: choice.id,
          label: choice.label,
          nextSceneId: choice.nextSceneId ?? null,
          cueCardText: choice.cueCardText ?? '',
        })),
        autoNextSceneId: scene.autoNextSceneId ?? null,
        notes: scene.notes ?? '',
      };
    }),
    assets: Array.isArray(project.assets) ? project.assets.slice() : [],
  };
}

export function hydrateProject(serialized, { previousProject = null } = {}) {
  if (!serialized) {
    return createProject();
  }

  if (previousProject) {
    revokeProjectObjectUrls(previousProject);
  }

  const scenes = Array.isArray(serialized.scenes) ? serialized.scenes : [];
  const preparedScenes = scenes.map(scene => {
    const imageBlob = scene.image?.blob ?? null;
    const bgBlob = scene.backgroundAudio?.blob ?? null;
    const dialogue = Array.isArray(scene.dialogue) ? scene.dialogue : [];
    return {
      id: scene.id,
      type: scene.type ?? SceneType.INTERMEDIATE,
      image: scene.image
        ? {
          name: scene.image.name ?? '',
          blob: imageBlob,
          objectUrl: imageBlob ? safeCreateObjectURL(imageBlob) : null,
        }
        : null,
      backgroundAudio: scene.backgroundAudio
        ? {
          name: scene.backgroundAudio.name ?? '',
          blob: bgBlob,
          objectUrl: bgBlob ? safeCreateObjectURL(bgBlob) : null,
        }
        : null,
      dialogue: dialogue.map(line => {
        const audioBlob = line.audio?.blob ?? null;
        return {
          text: line.text ?? '',
          audio: line.audio
            ? {
              name: line.audio.name ?? '',
              blob: audioBlob,
              objectUrl: audioBlob ? safeCreateObjectURL(audioBlob) : null,
            }
            : null,
        };
      }),
      choices: Array.isArray(scene.choices) ? scene.choices.map(choice => ({
        id: choice.id,
        label: choice.label ?? '',
        nextSceneId: choice.nextSceneId ?? null,
        cueCardText: choice.cueCardText ?? '',
      })) : [],
      autoNextSceneId: scene.autoNextSceneId ?? null,
      notes: scene.notes ?? '',
    };
  });

  return createProject({
    meta: serialized.meta,
    scenes: preparedScenes.map(scene => createScene(scene)),
    assets: Array.isArray(serialized.assets) ? serialized.assets.slice() : [],
  });
}

async function reseedPersistence(project) {
  if (!project || !isIndexedDBAvailable()) return;
  const snapshot = serializeProject(project);
  if (!snapshot) return;
  let db;
  try {
    db = await openDatabase();
    await writeSnapshot(db, snapshot);
  } catch (err) {
    console.warn('Failed to reseed IndexedDB after manual import/export', err);
  } finally {
    if (db) db.close();
  }
}

export async function setupPersistence(store, { showMessage = noop } = {}) {
  if (!isIndexedDBAvailable()) {
    if (typeof showMessage === 'function') {
      showMessage({ textId: 'persistence.autosaveUnavailable' });
    }
    return noop;
  }

  let db;
  try {
    db = await openDatabase();
  } catch (err) {
    console.error('Failed to open IndexedDB', err);
    if (typeof showMessage === 'function') {
      showMessage({ textId: 'persistence.autosaveOpenFailed' });
    }
    return noop;
  }

  let disabled = false;
  let applyingSnapshot = false;
  let debounceHandle = null;

  const notify = typeof showMessage === 'function' ? showMessage : noop;

  async function loadSnapshot() {
    try {
      const snapshot = await readSnapshot(db);
      if (snapshot) {
        applyingSnapshot = true;
        try {
          const hydrated = hydrateProject(snapshot, { previousProject: store.get().project });
          seedIdSequencesFromProject(hydrated);
          store.set({ project: hydrated });
        } finally {
          applyingSnapshot = false;
        }
      }
    } catch (err) {
      console.error('Failed to read persisted project', err);
      notify({ textId: 'persistence.autosaveReadFailed' });
      disabled = true;
    }
  }

  await loadSnapshot();

  async function persistNow() {
    if (disabled) return;
    try {
      const { project } = store.get();
      await writeSnapshot(db, serializeProject(project));
    } catch (err) {
      console.error('Failed to persist project', err);
      if (!disabled) {
        notify({ textId: 'persistence.autosaveWriteFailed' });
      }
      disabled = true;
    }
  }

  function scheduleSave() {
    if (disabled || applyingSnapshot) return;
    if (debounceHandle) {
      clearTimeout(debounceHandle);
    }
    debounceHandle = setTimeout(() => {
      debounceHandle = null;
      persistNow().catch(err => {
        console.error('Autosave failed', err);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  const unsubscribe = store.subscribe(() => {
    scheduleSave();
  });

  return () => {
    if (debounceHandle) {
      clearTimeout(debounceHandle);
      debounceHandle = null;
    }
    unsubscribe();
    if (db) {
      db.close();
    }
  };
}

function serializePlainProjectJson(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ProjectImportError(ImportErrorCode.INVALID_JSON, 'Project JSON must be an object');
  }
  const scenes = Array.isArray(json.scenes) ? json.scenes.slice(0, 20) : [];
  return {
    meta: { ...json.meta },
    scenes,
    assets: Array.isArray(json.assets) ? json.assets.slice() : [],
  };
}

function validateImportedProject(project, warnings = []) {
  const validation = validateProject(project);
  if (validation.errors.length) {
    revokeProjectObjectUrls(project);
    throw new ProjectImportError(
      ImportErrorCode.INVALID_PROJECT,
      'Imported project failed validation',
      {
        errors: validation.errors,
        warnings: [...validation.warnings, ...warnings],
      },
    );
  }
  return {
    errors: validation.errors,
    warnings: [...validation.warnings, ...warnings],
  };
}

export async function prepareProjectImport(file) {
  const name = file?.name ? String(file.name).toLowerCase() : '';
  const mime = file?.type ? String(file.type).toLowerCase() : '';
  const isZip = name.endsWith('.zip') || mime === 'application/zip' || mime === 'application/x-zip-compressed';
  const isJson = name.endsWith('.json') || mime === 'application/json' || mime === 'text/json' || !isZip;

  let serialized;
  let missingMediaPaths = [];

  if (isZip) {
    const extracted = await extractProjectFromArchive(file, { includeWarnings: true });
    serialized = extracted.serialized;
    missingMediaPaths = [...new Set(extracted.missingMediaPaths)];
  } else if (isJson) {
    let json;
    try {
      const text = await file.text();
      json = JSON.parse(text);
    } catch (err) {
      throw new ProjectImportError(ImportErrorCode.INVALID_JSON, 'Project JSON is unreadable');
    }
    serialized = serializePlainProjectJson(json);
  }

  const project = hydrateProject(serialized);
  const validation = validateImportedProject(project);
  return {
    project,
    validation,
    missingMediaPaths,
  };
}

export async function applyPreparedProjectImport(store, preparedImport) {
  const project = preparedImport?.project;
  if (!project) {
    throw new ProjectImportError(ImportErrorCode.INVALID_PROJECT, 'Prepared import is missing project data');
  }
  const previous = store.get().project;
  revokeProjectObjectUrls(previous);
  seedIdSequencesFromProject(project);
  store.set({ project });
  await reseedPersistence(project);
}

export async function importProject(store, file) {
  const prepared = await prepareProjectImport(file);
  await applyPreparedProjectImport(store, prepared);
  return prepared;
}

export async function extractProjectFromArchive(fileOrBytes, options = {}) {
  const buffer = fileOrBytes instanceof Uint8Array
    ? fileOrBytes
    : new Uint8Array(await fileOrBytes.arrayBuffer());
  let unpacked;
  try {
    unpacked = await unzip(buffer);
  } catch (err) {
    throw new ProjectImportError(ImportErrorCode.INVALID_ZIP, 'Project archive is unreadable');
  }
  const projectEntry = unpacked['project.json'];
  if (!projectEntry) {
    throw new ProjectImportError(ImportErrorCode.MISSING_PROJECT_JSON, 'Archive is missing project.json');
  }
  const decoder = new TextDecoder();
  let parsed;
  try {
    parsed = JSON.parse(decoder.decode(projectEntry));
  } catch (err) {
    throw new ProjectImportError(ImportErrorCode.INVALID_JSON, 'Archive project.json is invalid');
  }
  const manifestVersion = parsed.manifestVersion ?? 0;
  const manifest = manifestVersion ? parsed.project : parsed;
  const files = { ...unpacked };
  delete files['project.json'];
  if (!manifest || typeof manifest !== 'object') {
    throw new ProjectImportError(ImportErrorCode.INVALID_PROJECT, 'Archive manifest missing project data');
  }
  const missingMediaPaths = [];
  const serialized = manifestToSerialized(manifest, files, missingMediaPaths);
  if (!serialized) {
    throw new ProjectImportError(ImportErrorCode.INVALID_PROJECT, 'Archive manifest invalid');
  }
  if (options.includeWarnings) {
    return { serialized, missingMediaPaths };
  }
  return serialized;
}

export async function exportProject(store) {
  const project = store.get().project;
  const { archiveData } = await createProjectArchive(project);
  const archiveBlob = new Blob([archiveData], { type: 'application/zip' });
  const url = URL.createObjectURL(archiveBlob);
  const a = document.createElement('a');
  a.href = url;
  const baseName = sanitizeFilename(project.meta?.title, 'roleplay');
  const downloadName = baseName && baseName.toLowerCase().endsWith('.zip')
    ? baseName
    : `${baseName}.zip`;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  await reseedPersistence(project);
}
