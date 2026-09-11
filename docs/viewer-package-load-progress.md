# Viewer package loading feedback

This change stacks on PR #273 (`codex/viewer-voice-workflow`). Neither PR is to be merged or retargeted as part of this work.

Published-package Browse buttons and direct links show Checking sign-in, Downloading, and Opening. Download percentages are shown only when the response supplies a usable total byte count without an additional content encoding. Otherwise the downloading label remains indeterminate. The percentage describes transfer, not ZIP parsing or worksheet preparation. There is no progress bar or automatic retry.

Browse keeps the selected row stable, blocks additional package loads, and restores the controls with an inline error after failure. Closing the dialog retains the previous behavior: the outstanding download can still finish opening the worksheet. Progress listeners stop updating closed UI. English and Traditional Chinese use the same layout. Screen readers receive stage announcements rather than every percentage update.

No environment variables, backend, authentication, package storage, voice workflow, RolePlayScene, frozen rewrite widget, launch hash, or postMessage contract changes are required.

## Verification

- `npm test`: 855 passing tests.
- `node scripts/viewer-package-load-progress-smoke.mjs`: real local streamed ZIP responses with synthetic API data and isolated browser storage; both entry points, English/Traditional Chinese, 1280×900 and 390×844; known and unknown totals; invalid ZIP retry; concurrent load prevention; closing during download and focus restoration.
- Optional `VIEWER_SMOKE_SCREENSHOTS` directory saves the eight loading-state screenshots. Loading surfaces fit their viewports, buttons retain width, and normal flows emit no console errors. There is no bottom action bar on the loading screen.
- Existing start-panel sizing behind the Browse modal extends slightly beyond the narrow viewport; it is outside this scoped change. The new direct-link loading panel explicitly uses border-box sizing.
- VPS proxy headers and real network conditions still need a manual check. Missing or encoded size information intentionally falls back to text without a percentage. ZIP parsing remains synchronous as before; Opening feedback does not change its performance.

On the VPS, fetch and switch to `codex/viewer-package-load-progress`, then pull with `--ff-only`. Test a published direct link and Browse under browser network throttling, including a failed request followed by explicit retry. No deployment or service restart is performed by this PR.
