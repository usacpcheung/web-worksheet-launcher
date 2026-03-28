# Phase 1 Blueprint Index

This index provides a single reliable entry point for Phase 1 contract and architecture references.

## Which doc is normative for what

- **Transport contract (popup launch + postMessage):** `docs/message-contract.md`
- **Route and versioning boundary for the compatibility slice:** `docs/phase1-route-versioning.md`
- **Data model boundaries (draft/snapshot/viewer/attempt):** `docs/adr-phase1-worksheet-model.md`
- **Runtime behavior target for later-phase editor/viewer:** `worksheet_launcher_editor_viewer_spec.md`
- **Relational persistence shape and identifier mapping:** `worksheet_launcher_db_schema.md`

## Phase 1 document links

- [`docs/message-contract.md`](./message-contract.md)
- [`docs/phase1-route-versioning.md`](./phase1-route-versioning.md)
- [`docs/adr-phase1-worksheet-model.md`](./adr-phase1-worksheet-model.md)
- [`worksheet_launcher_editor_viewer_spec.md`](../worksheet_launcher_editor_viewer_spec.md)
- [`worksheet_launcher_db_schema.md`](../worksheet_launcher_db_schema.md)



## Phase progress note

- **Post-Phase-1 update (March 28, 2026):** a production-ready local editor runtime slice has been delivered at `server/editor/`.
- This runtime work is intentionally outside the strict Phase 1 contracts/scaffolding boundary and does not alter the popup launch/postMessage v1 interface contract.
- Scope delivered: center editor workspace, single-question v1 editing, answer preview, debounced local autosave, IndexedDB latest-draft restore, and inline question validation.
