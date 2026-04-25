import { createStoredZip, decodeUtf8, parseStoredZip, toUint8Array, crc32 } from './zip-utils.js';

const PACKAGE_FORMAT = 'worksheet-package';
const PACKAGE_VERSION = 1;
const CONTENT_SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAssetKind(kind) {
  return kind === 'audio' ? 'audio' : 'image';
}

function normalizeAssetUsage(usage) {
  return usage === 'option_audio' ? 'option_audio' : usage === 'question_audio' ? 'question_audio' : 'question_image';
}

function normalizeMediaRefs(mediaRefs) {
  const refs = Array.isArray(mediaRefs) ? mediaRefs : [];
  return refs
    .map((ref) => {
      if (!isRecord(ref) || typeof ref.assetId !== 'string' || !ref.assetId.trim()) {
        return null;
      }
      return {
        assetId: String(ref.assetId),
        usage: normalizeAssetUsage(ref.usage),
      };
    })
    .filter(Boolean);
}

function normalizeWorksheetBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((block, index) => {
    const safe = isRecord(block) ? block : {};
    const position = Number.isInteger(safe.position) ? safe.position : index;
    if (safe.kind === 'question' || isRecord(safe.prompt)) {
      const prompt = isRecord(safe.prompt) ? safe.prompt : {};
      const responseConfig = isRecord(safe.responseConfig) ? { ...safe.responseConfig } : { inputType: 'text' };
      if (Array.isArray(responseConfig.options)) {
        responseConfig.options = responseConfig.options.map((option) => {
          if (!isRecord(option)) return option;
          return {
            ...option,
            mediaRefs: normalizeMediaRefs(option.mediaRefs),
          };
        });
      }
      return {
        ...safe,
        kind: 'question',
        position,
        prompt: {
          ...prompt,
          text: String(prompt.text || ''),
          format: prompt.format || 'plain_text',
          mediaRefs: normalizeMediaRefs(prompt.mediaRefs),
        },
        responseConfig,
      };
    }
    const content = isRecord(safe.content) ? safe.content : {};
    return {
      ...safe,
      kind: 'content',
      position,
      content: {
        ...content,
        text: String(content.text || ''),
        format: content.format || 'plain_text',
      },
    };
  });
}

function normalizeAssetManifestList(assetIndex) {
  const list = Array.isArray(assetIndex) ? assetIndex : [];
  return list
    .map((asset) => {
      if (!isRecord(asset)) return null;
      if (typeof asset.assetId !== 'string' || !asset.assetId.trim()) return null;
      const path = typeof asset.path === 'string' ? asset.path : null;
      if (path == null || !path.startsWith('media/') || path.includes('..') || path.includes('\\')) return null;
      return {
        assetId: String(asset.assetId),
        path,
        kind: normalizeAssetKind(asset.kind),
        usage: normalizeAssetUsage(asset.usage),
        mimeType: typeof asset.mimeType === 'string' ? asset.mimeType : null,
        byteLength: Number.isInteger(asset.byteLength) ? asset.byteLength : null,
        crc32: typeof asset.crc32 === 'string' ? asset.crc32 : null,
      };
    })
    .filter(Boolean);
}

function buildPackageManifest(draft) {
  const createdAt = draft?.metadata?.createdAt || nowIso();
  const updatedAt = draft?.metadata?.updatedAt || nowIso();
  return {
    format: PACKAGE_FORMAT,
    packageVersion: PACKAGE_VERSION,
    schemaVersion: CONTENT_SCHEMA_VERSION,
    generatedAt: nowIso(),
    worksheet: {
      localDraftId: String(draft?.localId || ''),
      title: String(draft?.title || 'Untitled worksheet'),
      createdAt,
      updatedAt,
    },
    provenance: {
      source: String(draft?.metadata?.origin || 'local_created'),
      importedFrom: draft?.metadata?.importedFrom || null,
    },
    assets: [],
  };
}

function createWorksheetPackageFromDraft(draft, assetRecordsById = new Map()) {
  if (!isRecord(draft)) {
    throw new Error('Draft record is required for package export.');
  }

  const worksheet = {
    title: String(draft.title || 'Untitled worksheet'),
    blocks: normalizeWorksheetBlocks(draft.blocks),
    metadata: {
      ...draft.metadata,
      localId: draft.localId,
      modelVersion: 'package-compatible-v1',
    },
  };

  const manifest = buildPackageManifest(draft);
  const entries = [
    { path: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { path: 'content/worksheet.json', data: JSON.stringify(worksheet, null, 2) },
  ];

  const seen = new Set();
  (Array.isArray(draft.assets) ? draft.assets : []).forEach((asset) => {
    if (!isRecord(asset) || typeof asset.assetId !== 'string') return;
    if (seen.has(asset.assetId)) return;
    seen.add(asset.assetId);

    const path = typeof asset.path === 'string' && asset.path.startsWith('media/')
      ? asset.path
      : `media/${String(asset.assetId)}`;
    const binary = assetRecordsById.get(asset.assetId)?.binary;
    if (!binary) return;
    const bytes = toUint8Array(binary);
    const checksum = crc32(bytes).toString(16).padStart(8, '0');

    manifest.assets.push({
      assetId: asset.assetId,
      path,
      kind: normalizeAssetKind(asset.kind),
      usage: normalizeAssetUsage(asset.usage),
      mimeType: asset.mimeType || null,
      byteLength: bytes.length,
      crc32: checksum,
    });

    entries.push({ path, data: bytes });
  });

  entries[0] = { path: 'manifest.json', data: JSON.stringify(manifest, null, 2) };
  return { manifest, worksheet, bytes: createStoredZip(entries) };
}

function parseWorksheetPackage(arrayBuffer) {
  const files = parseStoredZip(arrayBuffer);

  const manifestEntry = files.get('manifest.json');
  if (manifestEntry == null) {
    throw new Error('Invalid worksheet package: missing required file manifest.json');
  }
  const worksheetEntry = files.get('content/worksheet.json');
  if (worksheetEntry == null) {
    throw new Error('Invalid worksheet package: missing required file content/worksheet.json');
  }
  const manifestText = decodeUtf8(manifestEntry);
  const worksheetText = decodeUtf8(worksheetEntry);

  let manifest;
  let worksheet;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Invalid package manifest.json: ${error?.message || String(error)}`);
  }
  try {
    worksheet = JSON.parse(worksheetText);
  } catch (error) {
    throw new Error(`Invalid package worksheet.json: ${error?.message || String(error)}`);
  }

  if (manifest?.format !== PACKAGE_FORMAT || manifest?.packageVersion !== PACKAGE_VERSION) {
    throw new Error('Unsupported worksheet package format or packageVersion.');
  }

  const assets = normalizeAssetManifestList(manifest.assets);

  const seenAssetIds = new Set();
  const seenPaths = new Set();
  assets.forEach((asset) => {
    if (seenAssetIds.has(asset.assetId)) {
      throw new Error(`Package manifest has duplicate assetId: ${asset.assetId}`);
    }
    seenAssetIds.add(asset.assetId);

    if (seenPaths.has(asset.path)) {
      throw new Error(`Package manifest has duplicate asset path: ${asset.path}`);
    }
    seenPaths.add(asset.path);

    if (!files.has(asset.path)) {
      throw new Error(`Package asset is missing file: ${asset.path}`);
    }

    const fileData = files.get(asset.path);
    if (asset.byteLength !== null && fileData.length !== asset.byteLength) {
      throw new Error(`Package asset byteLength mismatch for ${asset.path}: expected ${asset.byteLength}, got ${fileData.length}`);
    }
    if (asset.crc32 !== null) {
      const actualCrc = crc32(fileData).toString(16).padStart(8, '0');
      if (actualCrc !== asset.crc32) {
        throw new Error(`Package asset CRC32 mismatch for ${asset.path}: expected ${asset.crc32}, got ${actualCrc}`);
      }
    }
  });

  return {
    manifest,
    worksheet: {
      ...worksheet,
      blocks: normalizeWorksheetBlocks(worksheet.blocks),
    },
    assets: assets.map((asset) => ({
      ...asset,
      binary: files.get(asset.path),
    })),
  };
}

function rewriteWorksheetPackageTitle(arrayBuffer, title) {
  const parsed = parseWorksheetPackage(arrayBuffer);
  const nextTitle = String(title || parsed.worksheet?.title || 'Untitled worksheet');
  const manifest = {
    ...parsed.manifest,
    generatedAt: nowIso(),
    worksheet: {
      ...(isRecord(parsed.manifest?.worksheet) ? parsed.manifest.worksheet : {}),
      title: nextTitle,
    },
  };
  const worksheet = {
    ...parsed.worksheet,
    title: nextTitle,
  };
  const entries = [
    { path: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { path: 'content/worksheet.json', data: JSON.stringify(worksheet, null, 2) },
    ...parsed.assets.map((asset) => ({ path: asset.path, data: asset.binary })),
  ];
  return createStoredZip(entries);
}

function mapLegacyJsonToPackageModel(parsedLegacy) {
  if (!isRecord(parsedLegacy)) {
    throw new Error('Legacy worksheet JSON must be an object.');
  }
  if (!Array.isArray(parsedLegacy.blocks) || parsedLegacy.blocks.length === 0) {
    throw new Error('Imported worksheet must have a non-empty blocks array.');
  }

  const metadata = isRecord(parsedLegacy.metadata) ? parsedLegacy.metadata : {};

  return {
    worksheet: {
      title: String(parsedLegacy.title || 'Imported worksheet'),
      blocks: normalizeWorksheetBlocks(parsedLegacy.blocks),
      metadata: {
        ...metadata,
        origin: metadata.origin || 'legacy_json_import',
        importedFrom: 'legacy_json',
        modelVersion: 'package-compatible-v1',
      },
    },
    manifest: {
      format: PACKAGE_FORMAT,
      packageVersion: PACKAGE_VERSION,
      schemaVersion: CONTENT_SCHEMA_VERSION,
      generatedAt: nowIso(),
      worksheet: {
        title: String(parsedLegacy.title || 'Imported worksheet'),
      },
      provenance: {
        source: 'legacy_json_import',
        importedFrom: 'legacy_json',
      },
      assets: [],
    },
    assets: [],
  };
}

export {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  CONTENT_SCHEMA_VERSION,
  createWorksheetPackageFromDraft,
  parseWorksheetPackage,
  rewriteWorksheetPackageTitle,
  mapLegacyJsonToPackageModel,
  normalizeWorksheetBlocks,
};
