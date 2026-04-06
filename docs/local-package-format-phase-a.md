# Local package-first worksheet format (Phase A)

Status: implemented groundwork for local-first editor import/export.

> Current-state note (2026-04-06): this Phase A document is historical for local package behavior.
> Server-backed upload/publish/browse foundations now exist under `server/api/` (see `docs/phase-d-server-foundation.md`).

## Goals in this phase

- Make ZIP package export the primary local export path.
- Keep legacy JSON import as a compatibility path only.
- Introduce package-compatible worksheet + asset model for local drafts.
- Store imported package assets in browser local storage (`localAssets` IndexedDB store).
- Keep local-first editor/viewer behavior independent from server availability.

## Package structure (v1)

```
manifest.json
content/worksheet.json
media/*
```

### `manifest.json`

Required fields:

- `format`: fixed string `worksheet-package`
- `packageVersion`: integer, currently `1`
- `schemaVersion`: integer, currently `1`
- `generatedAt`: ISO timestamp
- `worksheet`: metadata (`localDraftId`, `title`, `createdAt`, `updatedAt`)
- `provenance`: source metadata (`source`, `importedFrom`)
- `assets`: array of logical asset entries

Asset entries:

- `assetId`: logical ID used by content references
- `path`: package-relative path (must be under `media/`)
- `kind`: `image` or `audio`
- `usage`: `question_image` | `question_audio` | `option_audio`
- `mimeType`: MIME type when known
- `byteLength`: uncompressed byte count
- `crc32`: stored ZIP CRC32 checksum as hex

### `content/worksheet.json`

- `title`
- `blocks[]`
- `metadata`

Question block media references:

- `blocks[i].prompt.mediaRefs[]` holds logical references (`assetId`, `usage`)
- `blocks[i].responseConfig.options[j].mediaRefs[]` holds logical references (`assetId`, `usage`), including future option audio

Content references use logical `assetId` values and do not use raw package paths.

## Local model changes (Phase A)

Local draft record now supports:

- `assets[]` in draft root with package asset metadata (`assetId`, `kind`, `usage`, `mimeType`, `path`)
- `metadata.modelVersion = "package-compatible-v1"`
- `metadata.importedFrom` for compatibility/provenance markers

### Local browser storage

IndexedDB now includes `localAssets` for binary media records.

- key: `localId` (`assetId`)
- payload includes `binary` (`Uint8Array`) and metadata
- imported package media is stored in `localAssets`
- package export resolves draft assets from `localAssets`

## Import behavior

### Package ZIP import

1. Parse ZIP (stored entries in current Phase A implementation).
2. Validate presence and JSON validity of:
   - `manifest.json`
   - `content/worksheet.json`
3. Validate manifest format/version and asset-file presence.
4. Persist imported package metadata in `importedWorksheets`.
5. Persist package media blobs in `localAssets`.
6. Convert imported package to a **new** local draft when editor import is used.

Import does not silently overwrite an existing draft ID; a new draft record is created.

### Legacy JSON compatibility import

Accepted only when legacy JSON can map safely:

- must parse as object
- must include non-empty `blocks[]`

Mapping:

- legacy `title`, `blocks`, `metadata` -> package-compatible worksheet draft
- no media files are created (assets array defaults empty)
- provenance stamped as `legacy_json_import` and `importedFrom: legacy_json`

Invalid/unsafe legacy JSON is rejected with explicit errors.

## Export behavior

- Primary export is ZIP package (`.zip`) generated from the current local draft.
- Export includes `manifest.json`, `content/worksheet.json`, and available media files from `localAssets`.
- Legacy JSON export is no longer the primary flow in editor UI.

## Deferred items (intentionally out of scope in Phase A)

- Full editor/viewer wiring to real server upload/publish/browse APIs.
- Full T2A overwrite/pipeline for option audio generation.
- Advanced offline/service worker/cache workflows.
