# Task: Parent launcher dedupe and cleanup

## Context

There were two copies of `parent-launcher.js` in the repository:

- Canonical SDK: `parent_prototype/sdk/parent-launcher.js`
- Legacy duplicate: `server/worksheet_launcher/parent-launcher.js`

The duplicate file created maintenance risk because both files needed to remain synchronized.

## Goal

Keep a single canonical parent launcher implementation and remove redundant copy drift risk.

## Scope

- Remove `server/worksheet_launcher/parent-launcher.js`.
- Keep `parent_prototype/sdk/parent-launcher.js` as the only source of truth.
- Update docs to remove references to the deleted server path.
- Update integration examples to reference the prototype/local SDK path.

## Non-goals

- No popup message-contract schema changes.
- No runtime behavior changes in launcher logic.

## Acceptance criteria

- [x] `server/worksheet_launcher/parent-launcher.js` is deleted.
- [x] `docs/parent-launcher-sdk.md` no longer references `/worksheet/parent-launcher.js`.
- [x] `docs/parent-launcher-sdk.md` clearly states canonical usage of `parent_prototype/sdk/parent-launcher.js`.
- [x] `parent_prototype/sdk/parent-launcher.js` remains unchanged functionally.
