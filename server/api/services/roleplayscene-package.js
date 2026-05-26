import { createStoredZip, decodeUtf8 } from '../../editor/zip-utils.js';
import { unzipSync } from '../../roleplayscene/scripts/vendor/fflate.module.js';

export const ROLEPLAYSCENE_PACKAGE_FORMAT = 'roleplayscene-package';
export const ROLEPLAYSCENE_PACKAGE_VERSION = 1;
export const ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET = 'roleplayscene/drafts';
export const ROLEPLAYSCENE_PUBLISHED_ARTIFACT_BUCKET = 'roleplayscene/published';

const MANIFEST_PATH = 'manifest.json';
const PROJECT_PATH = 'content/project.json';
const MEDIA_PREFIX = 'media/';
const textEncoder = new TextEncoder();

function normalizeText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function parseZipEntries(zipBytes) {
  const entries = unzipSync(zipBytes);
  return new Map(Object.entries(entries));
}

function parseJsonEntry(files, path, {
  missingCode,
  missingMessage,
  invalidCode,
  invalidMessage,
}) {
  const bytes = files.get(path);
  if (!bytes) {
    throw Object.assign(new Error(missingMessage), { code: missingCode });
  }
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    throw Object.assign(new Error(invalidMessage), {
      code: invalidCode,
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

const BUBBLE_MODES = new Set(['anchor', 'center', 'hidden']);
const MAX_SPEECH_BUBBLE_ANCHORS = 4;

function hasDialogueContent(line) {
  return Boolean(String(line?.text || '').trim() || line?.audio);
}

function isValidCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateRolePlaySceneBubbleConfig(project) {
  const errors = [];
  const warnings = [];
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  for (const scene of scenes) {
    const sceneId = scene?.id || 'unknown';
    const speechBubble = scene?.speechBubble || {};
    if (speechBubble.enabled !== true) continue;
    const anchors = Array.isArray(speechBubble.anchors) ? speechBubble.anchors : [];
    if (anchors.length > MAX_SPEECH_BUBBLE_ANCHORS) {
      errors.push(`Scene "${sceneId}" has ${anchors.length} speech bubble anchors; maximum is ${MAX_SPEECH_BUBBLE_ANCHORS}.`);
    }
    const anchorIds = new Set();
    const duplicateAnchorIds = new Set();
    for (const [index, anchor] of anchors.entries()) {
      const anchorId = typeof anchor?.id === 'string' ? anchor.id.trim() : '';
      if (!anchorId) {
        errors.push(`Speech bubble anchor ${index + 1} in scene "${sceneId}" is missing an ID.`);
      } else if (anchorIds.has(anchorId)) {
        duplicateAnchorIds.add(anchorId);
      } else {
        anchorIds.add(anchorId);
      }
      if (!isValidCoordinate(anchor?.x) || !isValidCoordinate(anchor?.y)) {
        errors.push(`Speech bubble anchor "${anchor?.label || anchorId || `#${index + 1}`}" in scene "${sceneId}" has invalid coordinates.`);
      }
    }
    duplicateAnchorIds.forEach(anchorId => {
      errors.push(`Speech bubble anchor ID "${anchorId}" in scene "${sceneId}" is duplicated.`);
    });

    const dialogue = Array.isArray(scene?.dialogue) ? scene.dialogue : [];
    const visibleLines = dialogue.filter(line => (
      hasDialogueContent(line) && line?.bubble?.mode !== 'hidden'
    ));
    if (visibleLines.length === 0) {
      warnings.push(`Scene "${sceneId}" has speech bubble mode enabled but no visible dialogue lines.`);
    }

    for (const anchor of anchors) {
      const used = dialogue.some(line => (
        line?.bubble?.mode === 'anchor' && line?.bubble?.anchorId === anchor?.id
      ));
      if (!used) {
        warnings.push(`Speech bubble anchor "${anchor?.label || anchor?.id || 'unknown'}" in scene "${sceneId}" is not used by any dialogue line.`);
      }
    }

    dialogue.forEach((line, index) => {
      if (!hasDialogueContent(line)) return;
      const mode = line?.bubble?.mode ?? 'center';
      if (!BUBBLE_MODES.has(mode)) {
        errors.push(`Dialogue line ${index + 1} in scene "${sceneId}" has an invalid speech bubble mode.`);
        return;
      }
      if (mode === 'hidden') {
        warnings.push(`Dialogue line ${index + 1} in scene "${sceneId}" is hidden from speech bubble mode.`);
      }
      if (mode === 'anchor') {
        const anchorId = typeof line?.bubble?.anchorId === 'string' ? line.bubble.anchorId.trim() : '';
        if (!anchorId || !anchorIds.has(anchorId)) {
          errors.push(`Dialogue line ${index + 1} in scene "${sceneId}" is assigned to a missing speech bubble anchor.`);
        }
      }
    });
  }
  return { errors, warnings };
}

export function getRolePlaySceneDraftArtifactBucket() {
  return ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET;
}

export function getRolePlayScenePublishedArtifactBucket() {
  return ROLEPLAYSCENE_PUBLISHED_ARTIFACT_BUCKET;
}

export function createRolePlaySceneDraftArtifactStoreInput({ identity, uploadedDraftId, zipBytes }) {
  return {
    ownerSub: identity?.sub,
    bucket: ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET,
    artifactId: uploadedDraftId,
    bytes: zipBytes,
  };
}

export function rewriteRolePlayScenePackageTitle(zipBytes, title) {
  const files = parseZipEntries(zipBytes);
  const manifest = parseJsonEntry(files, MANIFEST_PATH, {
    missingCode: 'ROLEPLAYSCENE_PACKAGE_MISSING_MANIFEST',
    missingMessage: 'RolePlayScene package is missing manifest.json.',
    invalidCode: 'INVALID_ROLEPLAYSCENE_MANIFEST_JSON',
    invalidMessage: 'RolePlayScene package manifest.json is malformed.',
  });
  const project = parseJsonEntry(files, PROJECT_PATH, {
    missingCode: 'ROLEPLAYSCENE_PACKAGE_MISSING_PROJECT',
    missingMessage: 'RolePlayScene package is missing content/project.json.',
    invalidCode: 'INVALID_ROLEPLAYSCENE_PROJECT_JSON',
    invalidMessage: 'RolePlayScene package content/project.json is malformed.',
  });
  const nextTitle = normalizeText(title, normalizeText(project?.meta?.title ?? manifest?.project?.title, 'Untitled RolePlayScene'));
  const nextManifest = {
    ...manifest,
    project: {
      ...(manifest?.project && typeof manifest.project === 'object' && !Array.isArray(manifest.project)
        ? manifest.project
        : {}),
      title: nextTitle,
    },
  };
  const nextProject = {
    ...project,
    meta: {
      ...(project?.meta && typeof project.meta === 'object' && !Array.isArray(project.meta)
        ? project.meta
        : {}),
      title: nextTitle,
    },
  };

  const entries = [...files.entries()].map(([path, bytes]) => {
    if (path === MANIFEST_PATH) {
      return { path, data: textEncoder.encode(JSON.stringify(nextManifest, null, 2)) };
    }
    if (path === PROJECT_PATH) {
      return { path, data: textEncoder.encode(JSON.stringify(nextProject, null, 2)) };
    }
    return { path, data: bytes };
  });
  return createStoredZip(entries);
}

function validateRolePlaySceneProjectForPlay(project) {
  const errors = [];
  const warnings = [];

  if (!project || !Array.isArray(project.scenes)) {
    return { errors: ['Project scenes are missing.'], warnings };
  }

  const scenes = project.scenes;
  const sceneIds = new Set(scenes.map(scene => scene?.id).filter(Boolean));
  const speakerIds = new Set((Array.isArray(project.speakers) ? project.speakers : [])
    .map(speaker => speaker?.id)
    .filter(Boolean));
  const seenSceneIds = new Set();
  for (const [index, scene] of scenes.entries()) {
    const sceneId = typeof scene?.id === 'string' ? scene.id.trim() : '';
    if (!sceneId) {
      errors.push(`Scene ${index + 1} is missing an ID.`);
      continue;
    }
    if (seenSceneIds.has(sceneId)) {
      errors.push(`Scene ID "${sceneId}" is duplicated.`);
    }
    seenSceneIds.add(sceneId);
  }
  const startScenes = scenes.filter(scene => scene?.type === 'start');
  if (startScenes.length !== 1) {
    errors.push(`Project must have exactly 1 start scene (found ${startScenes.length}).`);
  }

  const endScenes = scenes.filter(scene => scene?.type === 'end');
  if (endScenes.length < 1) {
    errors.push('Project must have at least 1 end scene.');
  } else if (endScenes.length > 3) {
    errors.push(`Project can have at most 3 end scenes (found ${endScenes.length}).`);
  }

  if (scenes.length === 0 || scenes.length > 20) {
    errors.push(`Project must have between 1 and 20 scenes (found ${scenes.length}).`);
  }

  for (const scene of scenes) {
    const sceneId = scene?.id || 'unknown';
    const sceneChoices = Array.isArray(scene?.choices) ? scene.choices : [];
    if (sceneChoices.length > 3) {
      errors.push(`Scene "${sceneId}" has ${sceneChoices.length} choices; maximum is 3.`);
    }
    sceneChoices.forEach((choice, idx) => {
      if (!choice?.nextSceneId) {
        errors.push(`Choice ${idx + 1} in scene "${sceneId}" is missing a destination.`);
        return;
      }
      if (!sceneIds.has(choice.nextSceneId)) {
        errors.push(`Choice "${choice.label || `#${idx + 1}`}" in scene "${sceneId}" links to missing scene "${choice.nextSceneId}".`);
      }
    });

    const autoNext = scene?.autoNextSceneId ?? null;
    if (autoNext) {
      if (scene?.type === 'end') {
        errors.push(`End scene "${sceneId}" cannot auto-advance to "${autoNext}".`);
      } else if (sceneChoices.length > 0) {
        errors.push(`Scene "${sceneId}" cannot have both choices and an auto-advance destination.`);
      }
      if (!sceneIds.has(autoNext)) {
        errors.push(`Scene "${sceneId}" auto-advances to missing scene "${autoNext}".`);
      }
    }

    if (scene?.type === 'end' && sceneChoices.length > 0) {
      warnings.push(`End scene "${sceneId}" should not have outgoing choices.`);
    }

    (Array.isArray(scene?.dialogue) ? scene.dialogue : []).forEach((line, idx) => {
      if (line?.speakerId && !speakerIds.has(line.speakerId)) {
        warnings.push(`Dialogue line ${idx + 1} in scene "${sceneId}" is assigned to a missing speaker.`);
      }
    });
  }

  if (startScenes.length === 1) {
    const reachable = new Set();
    const queue = [startScenes[0].id];
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (reachable.has(currentId)) continue;
      reachable.add(currentId);
      const scene = scenes.find(s => s?.id === currentId);
      if (!scene) continue;
      for (const choice of scene.choices || []) {
        if (choice.nextSceneId && sceneIds.has(choice.nextSceneId)) {
          queue.push(choice.nextSceneId);
        }
      }
      if (scene.autoNextSceneId && sceneIds.has(scene.autoNextSceneId)) {
        queue.push(scene.autoNextSceneId);
      }
    }
    for (const scene of scenes) {
      if (!reachable.has(scene?.id)) {
        errors.push(`Scene "${scene?.id || 'unknown'}" is unreachable from the Start scene.`);
      }
    }
  }

  return { errors, warnings };
}

export function validateRolePlayScenePackageForPublish(zipBytes) {
  const validation = validateRolePlayScenePackage(zipBytes);
  if (!validation.ok) return validation;

  const errors = [];
  if (validation.metadata.missingMediaCount > 0) {
    errors.push(...validation.warnings
      .filter(warning => warning?.code === 'ROLEPLAYSCENE_MEDIA_MISSING')
      .map(warning => warning.message || String(warning)));
  }
  const playValidation = validateRolePlaySceneProjectForPlay(validation.project);
  const bubbleValidation = validateRolePlaySceneBubbleConfig(validation.project);
  errors.push(...playValidation.errors);
  errors.push(...bubbleValidation.errors);

  if (errors.length > 0) {
    return fail('INVALID_ROLEPLAYSCENE_PUBLISH_PACKAGE', 'RolePlayScene package is not valid for publishing.', {
      errors,
      warnings: [...playValidation.warnings, ...bubbleValidation.warnings],
      missingMediaCount: validation.metadata.missingMediaCount,
    });
  }

  return {
    ...validation,
    publishValidation: {
      errors: [],
      warnings: [...playValidation.warnings, ...bubbleValidation.warnings],
    },
  };
}

export function validateRolePlayScenePackage(zipBytes) {
  let files;
  try {
    files = parseZipEntries(zipBytes);
  } catch (error) {
    return fail('INVALID_ROLEPLAYSCENE_PACKAGE_ZIP', 'Uploaded RolePlayScene package is not a readable ZIP file.', {
      reason: error?.message || 'ZIP parsing failed.',
    });
  }

  let manifest;
  try {
    manifest = parseJsonEntry(files, MANIFEST_PATH, {
      missingCode: 'ROLEPLAYSCENE_PACKAGE_MISSING_MANIFEST',
      missingMessage: 'RolePlayScene package is missing manifest.json.',
      invalidCode: 'INVALID_ROLEPLAYSCENE_MANIFEST_JSON',
      invalidMessage: 'RolePlayScene package manifest.json is malformed.',
    });
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
    project = parseJsonEntry(files, PROJECT_PATH, {
      missingCode: 'ROLEPLAYSCENE_PACKAGE_MISSING_PROJECT',
      missingMessage: 'RolePlayScene package is missing content/project.json.',
      invalidCode: 'INVALID_ROLEPLAYSCENE_PROJECT_JSON',
      invalidMessage: 'RolePlayScene package content/project.json is malformed.',
    });
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
  const bubbleValidation = validateRolePlaySceneBubbleConfig(project);
  warnings.push(...bubbleValidation.errors.map(message => ({
    code: 'ROLEPLAYSCENE_SPEECH_BUBBLE_INVALID',
    message,
  })));
  warnings.push(...bubbleValidation.warnings.map(message => ({
    code: 'ROLEPLAYSCENE_SPEECH_BUBBLE_WARNING',
    message,
  })));

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
