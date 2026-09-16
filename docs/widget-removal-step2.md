# Widget retirement: Step 2

This code-only PR is stacked on Step 1 (#279). It must not change any function
of the worksheet editor, viewer or RolePlayScene. Both PRs remain unmerged
during validation; this document does not authorize a VPS deployment.

## Exact deletion scope and code evidence

| Retired file | Why it is exclusive to the legacy feature |
| --- | --- |
| `parent_prototype/parent.html` | Demo loads the parent SDK and creates selector/callback popup launchers. |
| `parent_prototype/sdk/parent-launcher.js` | Defines `WorksheetLauncher.create`, builds `w/rid/returnOrigin` popup URLs, consumes `worksheetResult`; its only in-repo runtime caller is the demo. |
| `server/worksheet_launcher/render.html` | Loads only renderer/widget scripts and styles for the old answer/send-back page. |
| `server/worksheet_launcher/render.js` | Parses the legacy query, calls `RewriteWidget.mount`, posts `worksheetResult` to its opener. No core product imports it. |
| `server/worksheet_launcher/render.css` | Styles that renderer; only the retired HTML loads it. |
| `server/worksheet_launcher/widgets/rewrite-widget.js` | Defines the browser-global widget, its status poller, widget-local drafts and rewrite UI; only the renderer calls it in this repo. |
| `server/worksheet_launcher/widgets/rewrite-widget.css` | Overrides widget styles under the renderer's `.worksheet-light-theme`; only the renderer loads it. |
| `server/worksheet_launcher/render-source.test.mjs` | Two source-text assertions about the removed renderer, not product behavior tests. Replaced by retirement absence/boundary checks. |

The code search included runtime JS/HTML/CSS in editor, viewer, RolePlayScene,
shared app/API, the legacy directories and scripts. It covered paths, SDK
globals, result message names, widget host/storage identifiers and model-status.
This evidence establishes the in-repo boundary, not the absence of external users.

## Retained, unchanged

- All editor, viewer and RolePlayScene runtime files, styles, assets and existing
  product tests; all shared app runtime and Node API code.
- Viewer voice workflows imported by RolePlayScene discussion state/UI.
- `/api/rewrite-bridge/rewrite`, `/transcriptions`, `/t2a` under the same bridge
  prefix, and all `/api/worksheet-launcher/v1/*` product API routes.
- `/worksheet_launcher/app/login/popup.html`, its auth callback messaging,
  session gating and validation. It maps to shared `server/app/login/`, not the
  similarly named retired source directory.
- Drafts, attempts, ZIP formats, local storage, publishing and audio playback.
  `worksheetLauncher.locale` and `worksheetLauncher.viewer.printSchoolName*`
  are active product preference keys, not widget data. No storage cleanup runs.
- Database schema, dependency manifests, Apache/OIDC configuration and external
  bridge code. Even widget model-status endpoint removal is outside this PR.

The old parent integration deliberately stops being supplied by this repo.
Missing files normally return 404 on a static server; actual Apache behavior
depends on existing mappings. No redirect, replacement SDK or result-message
adapter is introduced. Product viewer URLs are not drop-in legacy popup URLs.

## Documentation

`AGENTS.md` now enforces the retained-product boundary instead of requiring
the deleted scaffold. README no longer recommends legacy embedding. The
message contract explicitly retires only the widget protocol, retaining the
active auth callback contract. Widget/SDK/security/Phase 1 references carry
superseding retirement notices; historical design text is retained for audit.
No supported product contract is removed.

## Validation and merge gates

Local result: **900/900 unit tests and all ten browser smoke scripts passed**.
HTTP checks returned 404 for the seven retired runtime assets and 200 for the
three product entry pages and shared login page. Product/shared runtime diffs
against #279 were empty. Browser validation used the existing Playwright scripts
(Browser plugin not available), Chromium, English/Traditional Chinese and
1280px/390px viewports. A loopback static server plus a directory-index proxy
served the branch at `http://127.0.0.1:8891`; the streaming test uses its own
fixture server. No live credentials, API services or production data were used.

- Run `npm test`: expected 900 tests (893 Step 1 tests minus two renderer-only
  assertions, plus eight exact-path absence checks and one retained-entry check).
- Run the ten existing smoke scripts: package sign-in styling, dialogue order,
  package load progress, Markdown, worksheet polish, completed review, imported
  IDs, viewer voice, native music navigation and RolePlayScene voice.
- Verify product/shared runtime diffs against #279 are empty. The only changed
  file under the retained product trees is the boundary test itself.
- Review CI and PR findings. Merge #279 before this PR; retarget this PR to
  `main-v1` and rerun checks before its merge. Do not bypass branch protections.

Local browser checks use isolated storage and synthetic API/microphone fixtures;
they do not prove live OIDC, upstream AI providers or real-device mic behavior.
Source-reference checks are tripwires, not a complete computed dependency graph.

## Required before VPS deployment

1. Inventory Apache aliases, static-copy/release directories and external parent
   integrations for the exact retired files and `/worksheet/render.html`.
   Confirm any remaining users accept retirement; do not disable a whole
   `/worksheet_launcher/` or `/api/rewrite-bridge/` prefix.
2. Record the exact current deployed commit and ensure a clean checkout. Preserve
   environment configuration, database and artifact storage. The previously
   validated baseline is `c84927e8d28e66aed1ccc44342c026539b2a34e1`.
3. Use the agreed maintenance window and disposable test content. Verify real
   HTTPS sign-in, editor save/reload/preview/publish, viewer load/resume/submit/
   review/voice and RolePlayScene edit/reorder/publish/play/discussion/music.
4. Inspect console/network/API logs and confirm shared assets/services load.
   Verify retired URLs do not accidentally map to a shared page or stale copy.
5. If a core regression appears, stop deployment and restore the exact recorded
   code release using the existing release process; restart the API if that
   process requires it. No database migration or Apache edit is part of this PR.
   Code rollback does not undo test data or local-browser edits.

The deleted files remain recoverable from Git history and the unmerged base
branch. Do not delete stored widget drafts, production artifacts or external
copies as an incidental cleanup. A third PR is needed only if an independently
reviewed cleanup remains after validation; it is not required to erase history.
