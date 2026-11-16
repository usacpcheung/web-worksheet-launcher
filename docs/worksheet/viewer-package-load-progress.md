# Viewer package loading feedback

> Aligned to PR #349 (`99ba300`) and PR2 cleanup on 2026-11-16. Code evidence: [main.js](../../server/viewer/main.js), [package-load-progress.js](../../server/viewer/package-load-progress.js), [viewer-package-load-progress-smoke.mjs](../../scripts/viewer-package-load-progress-smoke.mjs). Test commands below are guidance, not a new test-run report.

Published-package Browse buttons and direct links show Checking sign-in, Downloading, and Opening. Download percentages are shown only when the response supplies a usable total byte count without an additional content encoding. Otherwise downloading remains indeterminate. Percentages describe transfer, not ZIP parsing or worksheet preparation. There is no progress bar or automatic network retry.

Browse keeps the selected row stable and blocks additional package loads. A real failure restores controls with an inline error. Canceling replacement restores controls promptly, announces cancellation, and keeps filters, scroll and focus without an opening error. Closing the dialog invalidates its selected load; late work cannot replace the attempt. Cleanup of uniquely staged records can finish separately from the UI. Screen readers receive stage announcements rather than every percentage update. English and Traditional Chinese use the same layout.

`ViewerAttemptSession.startFromPublishedPackage` delegates opening to `package-opening.js`, which checks the session, downloads the artifact, yields once for feedback, then parses/imports it. Lifecycle consent and a successful write precede selecting the new normal attempt; see [local models](../contracts/local-models.md). The load progress object is UI-only and is not persisted. There is no publication-ID cache-first lookup. This flow has no editor-style download inactivity timeout; do not copy editor or RolePlayScene timeout claims into the viewer contract.

## Verification and rollout

- `npm test` (Node suite).
- `node scripts/viewer-package-load-progress-smoke.mjs` owns streamed fixture responses with synthetic APIs and isolated browser storage: known/unknown totals, invalid ZIP retry, concurrent prevention, close during download, focus, both locales and desktop/mobile.
- Optional `VIEWER_SMOKE_SCREENSHOTS` saves fixture screenshots outside the repository.

The reviewed source does not establish current live proxy headers or browser layout acceptance. Check published direct links and Browse with throttling, failure and explicit retry on the reviewed release. Missing/encoded size intentionally produces text without a percentage. ZIP parsing remains synchronous; Opening feedback does not promise smoother parsing. Historical PR #274 test counts and branch deployment instructions are superseded by this reference and the [testing guide](../operations/testing.md).
