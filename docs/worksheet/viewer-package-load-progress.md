# Viewer package loading feedback

> Current behavior reviewed against main `7bb19de` on 2026-10-06. Code evidence: [main.js](../../server/viewer/main.js), [package-load-progress.js](../../server/viewer/package-load-progress.js), [viewer-package-load-progress-smoke.mjs](../../scripts/viewer-package-load-progress-smoke.mjs). Test commands below are guidance, not a new test-run report.

Published-package Browse buttons and direct links show Checking sign-in, Downloading, and Opening. Download percentages are shown only when the response supplies a usable total byte count without an additional content encoding. Otherwise downloading remains indeterminate. Percentages describe transfer, not ZIP parsing or worksheet preparation. There is no progress bar or automatic network retry.

Browse keeps the selected row stable, blocks additional package loads, and restores controls with an inline error after failure. Closing the dialog does not cancel an accepted load: the outstanding download can still finish opening the worksheet. Progress listeners stop updating closed UI. Screen readers receive stage announcements rather than every percentage update. English and Traditional Chinese use the same layout.

`ViewerAttemptSession.startFromPublishedPackage` checks the session, downloads the artifact, yields once for feedback, then parses/imports it. The load progress object is UI-only and is not persisted. There is no publication-ID cache-first lookup. This flow has no editor-style download inactivity timeout; do not copy editor or RolePlayScene timeout claims into the viewer contract.

## Verification and rollout

- `npm test` (Node suite).
- `node scripts/viewer-package-load-progress-smoke.mjs` owns streamed fixture responses with synthetic APIs and isolated browser storage: known/unknown totals, invalid ZIP retry, concurrent prevention, close during download, focus, both locales and desktop/mobile.
- Optional `VIEWER_SMOKE_SCREENSHOTS` saves fixture screenshots outside the repository.

The reviewed source does not establish current live proxy headers or browser layout acceptance. Check published direct links and Browse with throttling, failure and explicit retry on the reviewed release. Missing/encoded size intentionally produces text without a percentage. ZIP parsing remains synchronous; Opening feedback does not promise smoother parsing. Historical PR #274 test counts and branch deployment instructions are superseded by this reference and the [testing guide](../operations/testing.md).
