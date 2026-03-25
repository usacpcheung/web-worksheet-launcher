# Worksheet contract modules

This folder contains Phase 1 contract/scaffolding utilities for the draft → snapshot → viewer → attempt model boundaries described in `docs/adr-phase1-worksheet-model.md`.

## Modules

- `validators.js`
  - `validateDraftSchema(draft)`
  - `validateSnapshotSchema(snapshot)`
  - `validateViewerPayloadSchema(viewerPayload)`
  - `validateAttemptPayloadSchema(attemptPayload)`
- `mappers.js`
  - `mapDraftToSnapshot(draft, publishMetadata)`
  - `mapSnapshotToViewerPayload(snapshot)`
  - `mapViewerPayloadAndResponsesToAttempt(viewerPayload, userResponses, attemptMetadata)`
- `fixtures/`
  - small example payloads for draft/snapshot/viewer/attempt in both `.json` and JS exports.

## Mapping guardrails

- Draft → snapshot mapping intentionally strips editor-only/transient fields like `clientRevision`, `draftMeta`, `localValidation`, and `uiState`.
- Snapshot → viewer payload mapping intentionally keeps the payload minimal and read-only (`worksheetId`, `snapshotId`, `snapshotVersion`, `title`, `blocks`).
- Viewer payload + responses → attempt mapping only accepts responses keyed by question block IDs from the viewer payload and excludes non-question block responses.

## Snapshot provenance guardrail

- Snapshot validation requires `sourceDraftRevision` to enforce publish provenance traceability.
- Mapper outputs deep-clone nested block structures so snapshot/viewer mapping does not share mutable references with source models.
