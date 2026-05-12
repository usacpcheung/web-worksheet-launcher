import { parseStoredZip, decodeUtf8 } from '../../editor/zip-utils.js';

export const ROLEPLAYSCENE_PACKAGE_FORMAT = 'roleplayscene-package';
export const ROLEPLAYSCENE_PACKAGE_VERSION = 1;
export const ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET = 'roleplayscene/drafts';

const MANIFEST_PATH = 'manifest.json';
const PROJECT_PATH = 'content/project.json';
const MEDIA_PREFIX = 'media/';

function normalizeText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function parseJsonEntry(files, path, errorCode, message) {
  const bytes = files.get(path);
  if (!bytes) {
    throw Object.assign(new Error(message), { code: errorCode });
  }
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    throw Object.assign(new Error(message), {
      code: 'INVALID_PROJECT_JSON',
      cause: error,
    });
  }
}

function collectReferencedMediaPaths(project) {
  const paths = new Set();
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  for (const scene of scenes) {
    for (const asset of [scene?.image, scene?.backgroundAudio]) {
      if (typeof asset?.path === 'string' && asset.path.trim()) {
        paths.add(asset.path.trim());
      }
    }
    const dialogue = Array.isArray(scene?.dialogue) ? scene.dialogue : [];
    for (const line of dialogue) {
      if (typeof line?.audio?.path === 'string' && line.audio.path.trim()) {
        paths.add(line.audio.path.trim());
      }
    }
  }
  return paths;
}

function collectManifestAssetPaths(manifest) {
  const paths = new Set();
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  for (const asset of assets) {
    if (typeof asset?.path === 'string' && asset.path.trim()) {
      paths.add(asset.path.trim());
    }
  }
  return paths;
}

function fail(code, message, details = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  };
}

export function getRolePlaySceneDraftArtifactBucket() {
  return ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET;
}

export function createRolePlaySceneDraftArtifactStoreInput({ identity, uploadedDraftId, zipBytes }) {
  return {
    ownerSub: identity?.sub,
    bucket: ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET,
    artifactId: uploadedDraftId,
    bytes: zipBytes,
  };
}

export function validateRolePlayScenePackage(zipBytes) {
  let files;
  try {
    files = parseStoredZip(zipBytes);
  } catch (error) {
    return fail('INVALID_ROLEPLAYSCENE_PACKAGE_ZIP', 'Uploaded RolePlayScene package is not a readable ZIP file.', {
      reason: error?.message || 'ZIP parsing failed.',
    });
  }

  let manifest;
  try {
    manifest = parseJsonEntry(files, MANIFEST_PATH, 'ROLEPLAYSCENE_PACKAGE_MISSING_MANIFEST', 'RolePlayScene package is missing manifest.json.');
  } catch (error) {
    return fail(error.code || 'INVALID_ROLEPLAYSCENE_MANIFEST', 'Uploaded RolePlayScene package manifest is invalid.', {
      reason: error.message,
    });
  }

  if (manifest?.format !== ROLEPLAYSCENE_PACKAGE_FORMAT) {
    return fail('UNSUPPORTED_ROLEPLAYSCENE_PACKAGE_FORMAT', 'Unsupported RolePlayScene package format.', {
      expected: ROLEPLAYSCENE_PACKAGE_FORMAT,
      actual: manifest?.format ?? null,
    });
  }
  if (manifest?.packageVersion !== ROLEPLAYSCENE_PACKAGE_VERSION) {
    return fail('UNSUPPORTED_ROLEPLAYSCENE_PACKAGE_VERSION', 'Unsupported RolePlayScene package version.', {
      expected: ROLEPLAYSCENE_PACKAGE_VERSION,
      actual: manifest?.packageVersion ?? null,
    });
  }

  let project;
  try {
    project = parseJsonEntry(files, PROJECT_PATH, 'ROLEPLAYSCENE_PACKAGE_MISSING_PROJECT', 'RolePlayScene package is missing content/project.json.');
  } catch (error) {
    return fail(error.code || 'INVALID_ROLEPLAYSCENE_PROJECT_JSON', 'Uploaded RolePlayScene project JSON is invalid.', {
      reason: error.message,
    });
  }

  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return fail('INVALID_ROLEPLAYSCENE_PROJECT', 'Uploaded RolePlayScene project must be an object.');
  }
  if (!Array.isArray(project.scenes)) {
    return fail('INVALID_ROLEPLAYSCENE_PROJECT', 'Uploaded RolePlayScene project scenes must be an array.');
  }
  if (project.scenes.length === 0) {
    return fail('INVALID_ROLEPLAYSCENE_PROJECT', 'Uploaded RolePlayScene project must contain at least one scene.');
  }
  const startSceneCount = project.scenes.filter(scene => scene?.type === 'start').length;
  if (startSceneCount < 1) {
    return fail('INVALID_ROLEPLAYSCENE_PROJECT', 'Uploaded RolePlayScene project must contain a start scene.');
  }

  const mediaPaths = new Set([...files.keys()].filter(path => path.startsWith(MEDIA_PREFIX)));
  const referencedMediaPaths = collectReferencedMediaPaths(project);
  const manifestAssetPaths = collectManifestAssetPaths(manifest);
  const expectedMediaPaths = new Set([...referencedMediaPaths, ...manifestAssetPaths]);
  const missingMediaPaths = [...expectedMediaPaths].filter(path => !mediaPaths.has(path)).sort();
  const warnings = missingMediaPaths.map(path => ({
    code: 'ROLEPLAYSCENE_MEDIA_MISSING',
    path,
    message: `Referenced media file is missing: ${path}`,
  }));

  const description = normalizeText(
    project?.meta?.description ?? manifest?.project?.description,
    ''
  );

  return {
    ok: true,
    metadata: {
      title: normalizeText(project?.meta?.title ?? manifest?.project?.title, 'Untitled RolePlayScene'),
      description,
      packageVersion: manifest.packageVersion,
      sceneCount: project.scenes.length,
      mediaCount: mediaPaths.size,
      missingMediaCount: missingMediaPaths.length,
      validationWarningCount: warnings.length,
    },
    warnings,
    manifest,
    project,
  };
}
