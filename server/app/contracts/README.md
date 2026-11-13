# Worksheet contract modules

This folder contains local contract/compatibility utilities used by editor/viewer for draft → snapshot → viewer → attempt model boundaries. See the [current local-model reference](../../../docs/contracts/local-models.md). The [Phase 1 ADR](../../../docs/past/phase1/adr-phase1-worksheet-model.md) preserves historical rationale but does not define today’s server API or SQL schema.

Terminology note:
- The utilities here still use `snapshot`/`worksheetId` naming for compatibility with existing local editor/viewer payload shapes.
- Current architecture direction is package-centered (`publishedPackageId`) for server-backed published content.
- Treat this folder as transitional client-side compatibility code, not the source of truth for server API identity fields.

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

Fill-in-the-blanks configuration and answer-map validation is shared through
`../fill-in-blanks.js`, including package readers and the server upload boundary.
See the [feature contract](../../../docs/worksheet/fill-in-the-blanks.md).

### Fill-in-the-blanks instructions

For `responseConfig.inputType = "fill_in_blanks"`, `prompt.text` must be a string
but may be empty: it holds optional instructions. The passage and at least one
valid blank are still required. Other question types continue to require
nonempty prompt text. This applies to draft, snapshot and viewer validation;
worksheet package v8 remains the fill-in-the-blanks format.
