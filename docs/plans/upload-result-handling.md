# Proposal: shared upload-result classification

Status: planning draft; implementation has not started. Baseline: `main`
`200f6b0fb7f6add1e6b4da02355fbb304c102fd4`, after PR #308.
This proposal does not describe an implemented API or replace the
[current runtime reference](../operations/server-runtime.md).

## Problem and evidence

PR #308 fixed an attempt handler that confused a non-auth upload failure with
an auth-gate block, preventing conflict recovery. Its live retest then found
cancellation falling through to an English API message in Chinese mode. Both
fixes are now on main. The supplied final acceptance report verified all eight
editor/viewer × language × cancellation-phase cases at `7b34d07`, including
real committed uploads whose responses were suppressed. No remaining defect
was reported in that matrix. The next change is preventive refactoring.

The current code splits related decisions across:

| Owner | Current responsibility |
| --- | --- |
| `server/app/api/server-api-client.js` | Transport, structured errors, operation IDs, receipt recovery, timeout and abort |
| `server/app/auth/shared-auth-gate.js` | Protected-action execution, probe blocks and authentication recovery; non-auth upload errors can be returned unchanged |
| `server/editor/main.js` | Draft upload feedback and slot-limit handling in `uploadCurrentDraftToServer` |
| `server/viewer/main.js` | Attempt error messages, conflict/slot state, and protected-action result handling in the Save attempt listener |
| `server/roleplayscene/scripts/main.js` | Snapshot/package preparation and explicit conflict/slot retry loop in `uploadCurrentProjectToServer` |

These callers do not have identical result shapes or UI flows. A universal
upload controller would increase the initial change's risk. Start by sharing
pure classification of upload results, with a separate adapter for auth-gate
results. Keep application dialogs, state ownership and localization local.

## Proposed implementation order

1. Characterize the existing caller behavior with tests before extraction.
   Include successful and recovered uploads, non-auth failures returned through
   the gate, blocked probes, late authentication failures, conflict cancel,
   copy/replace and copy followed by slot recovery. Record any product-specific
   differences explicitly; do not silently change them under refactoring.
2. Introduce a small pure module under `server/app/api/` for classifying raw
   upload results. Proposed categories: success, authentication required,
   name conflict, slot limit, canceled, uncertain transport failure, and other
   failure. Preserve original error codes, details, operation IDs, recovered
   flags and resource data. Handle absent/malformed results conservatively;
   never infer success or authentication solely from a missing field.
3. Keep auth-gate envelopes separate from upload outcomes. An adapter must
   recognize executed, redirected, blocked and invalid-intent results without
   treating them as raw upload failures. Preserve `requiresSignIn` and the
   existing auth-status checks, including transport failures that retained an
   HTTP authentication status. Do not change the shared gate's public return
   contract or callback validation for this extraction.
4. Migrate editor and viewer incrementally. Keep localized message keys,
   dialog choices, notification placement, cancellation controls, and busy-state
   ownership in each application. Only the current result may trigger recovery;
   stale conflict/slot state must not open a dialog after a different failure.
5. Migrate the RolePlayScene upload classification while retaining its existing
   snapshot, archive reuse, warning display and explicit retry loop. Trace
   `getServerErrorMessage` and its non-upload consumers before changing it.
   If characterization reveals a behavior defect, document and fix it explicitly
   rather than disguising it as extraction.
6. Remove only classification branches replaced by the shared implementation.
   Update the runtime reference and testing guidance to name the final owner.
   When delivered or superseded, move this proposal to `docs/past/` and update
   the index so it cannot become a competing current specification.

## Invariants and boundaries

- No automatic upload POST retries. Only an explicit user choice may start
  another upload after conflict/slot recovery. Preserve copy/replace intent.
- Receipt recovery remains bounded at its existing budget; cancellation stops
  lookup/backoff and does not undo an upload already committed by the server.
- Late results cannot overwrite a canceled or superseded operation's feedback.
- Local answers, draft content, package compatibility and source metadata stay
  intact; preserve snapshot boundaries during asynchronous package creation.
- Preserve both locales, mobile controls, existing server limits and actual
  authentication recovery. A session probe failure is not proof of logout.
- Do not change wire response schemas, fingerprints, database migrations,
  backend transactions, package formats, API deadlines or deployment settings.
- Durable operation persistence across reloads, retry/status screens, receipt
  retention, idempotent publishing, server-side cancellation and orphan
  reconciliation are separate features. This extraction does not solve those
  limitations and must not claim that it does.

## Validation and completion criteria

- Unit tests exercise classification and gate adapters with real representative
  result shapes, including unknown codes, missing fields and HTTP auth metadata.
- Run `npm test` and the full retained browser smoke suite (`npm run test:browser`)
  for the eventual cross-module implementation, as required by AGENTS.md.
- Retain and explicitly inspect upload-operation, upload-http-errors,
  attempt-upload-recovery-ui, upload-cancellation-ui and relevant RolePlayScene
  save/recovery coverage. Verify English/Traditional Chinese and desktop/narrow
  layouts. Keep polling counts separate from independent verification requests.
- Test cancel during both a pending receipt request and backoff, late responses,
  uncertain outcomes, no automatic duplicate POST, local content preservation,
  initial success and user-selected conflict/slot retries across all three apps.
- Review the final diff against characterization tests. Explain every behavior
  difference; otherwise the refactor must preserve the accepted baseline.
- Obtain passing required CI before marking the implementation ready. A focused
  deployment smoke check of changed paths complements the isolated simulations;
  do not present simulated requests as live server evidence or repeat all prior
  acceptance tests merely because a planning document changed.

This draft contains documentation only. No runtime tests are claimed for it.
Before implementation, apply the worksheet and RolePlayScene UI skills required
by the repository contributor rules to the affected application code.
