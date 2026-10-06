# Task: Parent launcher dedupe and cleanup

> **Historical archive — reviewed against main `7bb19de` on 2026-10-06.**
> Retired widget/SDK implementation or completed retirement record. The exact legacy assets are absent on current main; shared authentication, rewrite, transcription and audio services remain active. Historical installation/PR/deployment instructions below are not current operational guidance.
> Maintained replacement: [active retirement boundary](../../contracts/widget-retirement.md).
> Start with [current documentation](../../README.md) and [retirement boundary](../../contracts/widget-retirement.md). Original decision text and reported test results below describe their stated historical baseline, not validation run for this review.


> **Widget retirement (Step 2):** Historical completed task. The formerly canonical SDK has now also been retired; do not restore it using this checklist.
> See [scope, retained services and deployment gates](widget-removal-step2.md).

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
- [x] `docs/past/widget/parent-launcher-sdk.md` no longer references `/worksheet/parent-launcher.js`.
- [x] `docs/past/widget/parent-launcher-sdk.md` clearly states canonical usage of `parent_prototype/sdk/parent-launcher.js`.
- [x] `parent_prototype/sdk/parent-launcher.js` remains unchanged functionally.
