# Post-retirement code and test cleanup audit

## Decision and scope

Baseline: `173d09811128d2a6cd04342385f72aee4cb712dc` (`main-v1`, after PRs
#279–#285). This PR changes documentation only. It does not approve deletion,
change runtime behavior, remove tests, or authorize deployment.

**Invariant:** preserve every supported worksheet editor, viewer and RolePlayScene
function, including existing saved content, shared services and accessibility.
Test count is not a cleanup target.

Recommendation: approve the small editor cleanup below first. Keep the API and
RolePlayScene test migrations separate. No entire test file or viewer module is
currently justified for deletion by this audit.

## Method and coverage

- Inspected product entry HTML, imports and event wiring in editor/viewer
  `main.js`, RolePlayScene `scripts/main.js`, and the candidate implementations.
- Used tracked-file inventory and symbol searches across source, tests, scripts
  and documentation; traced candidate callers, exports, DOM creation and updates.
  `git grep` is used for reproducible repo-wide searches because this worktree
  lives under the parent checkout's ignored `.codex-review` directory. Explicit
  `rg` searches under `server/` were also used.
- A lexical scan of named functions and selected variable declarations was only
  a candidate finder, **not** proof of dead code. Checked the resulting candidates
  against callbacks, immediately invoked functions, exports and tests.
- Followed shared package/audio/voice consumers, legacy import paths, production
  artifact-store calls and selected source-string tests.
- Ran `node --test "server/**/*.test.mjs"` using Node 24 on the unchanged baseline:
  **929 passed, 0 failed, 0 skipped**.

This is a targeted static audit, not an exhaustive control-flow or production
coverage analysis. It does not establish whether externally hosted modules,
deployment scripts outside Git, all dynamic selectors, every locale key or every
CSS rule are unused. No browser tests, live provider requests, database operations
or VPS checks were run for this documentation-only PR.

## Candidates supported by code evidence

Line references below refer to the baseline commit, not future edits.

### A1 — Unused editor publish-count local: safe in-repo removal candidate

- [editor main](../server/editor/main.js), line 7850: `activePublishCount` is
  assigned from `session.state.publishingDraftIds?.size || 0` in `updateSummary`
  and never read. Tracked-repo symbol search returns just this declaration.
- The initializer only reads the existing Set size; no operation is lost by
  removing this local declaration.
- **Retain `publishingDraftIds` itself.** Lines 3784–3833 implement duplicate
  publish guarding and cleanup; lines 7675/7686 use it for row controls.
- Test impact: no test references this local. Do not remove publish tests.
- Verify publish busy/duplicate handling, success/failure recovery and activity
  rendering, plus the full Node suite, after the proposed deletion.

### A2 — Empty, always-hidden option audio status span: safe in-repo candidate

- [editor main](../server/editor/main.js), lines 7532–7536, creates and appends
  `optionAudioAttached`, sets `data-option-audio-attached`, and hides it without
  assigning content. Lines 6431 and 6446–6448 only find it, hide it again and
  empty its text. Those are all tracked references to the symbol/selector.
- No event handler or state transition makes this span visible or populates it.
  `.option-row__meta` in [editor CSS](../server/editor/main.css) only sets grid
  placement/margin; it does not override the span's native hidden behavior.
- Actual attachment feedback remains in per-language track sections:
  `data-audio-track-status`, `option-audio-track--attached`, and stale-source
  warnings in `refreshOptionRowT2AControls` and the track renderer (around
  lines 6462 and 7348). **Do not delete these or the length-limit hint.**
- Proposed scope: remove only span creation and its no-op refresh block/query.
  Keep the shared `.option-row__meta` class, used by the text-length hint.
- Test impact: no test references the retired span. Keep and run
  `editor-option-audio-smoke.mjs`; check attachment/replacement/play/removal,
  all supported audio languages, stale text, busy states and focus restoration.

### B1 — Three test-only artifact helpers: migrate coverage before removal

- [RolePlayScene package service helpers](../server/api/services/roleplayscene-package.js),
  lines 239–253: `getRolePlaySceneDraftArtifactBucket`,
  `getRolePlayScenePublishedArtifactBucket`, and
  `createRolePlaySceneDraftArtifactStoreInput` have no in-repo runtime callers.
- Tracked imports of this module were inspected. The production
  [draft service](../server/api/services/roleplayscene-draft-service.js) imports
  the bucket constants directly and constructs actual `storeArtifact` inputs in
  `createDraftArtifact`/`createPublishedArtifact` (lines 182–198).
- The wrappers are exercised only by the bucket-isolation test in
  [package tests](../server/api/services/roleplayscene-package.unit.test.mjs),
  lines 482–505. That security/data-isolation requirement is still valid.
- [Draft-service tests](../server/api/services/roleplayscene-draft-service.unit.test.mjs)
  already inspect the actual stored bucket at lines 376, 809 and 855. Before
  removing helpers, ensure tests of the production calls also assert owner,
  artifact ID and bytes for both draft and published storage. Preserve direct
  constant/isolation assertions; remove only assertions/imports exclusive to the
  deleted wrappers. Do not delete the package test file.
- These are exported functions. No public package exports are declared in
  `package.json` and the package is private, but external direct imports cannot
  be disproved locally. Confirm no external consumer relies on these names
  before removing exports. Bucket values, routes and storage layout must not change.

### B2 — RolePlayScene `importProject` wrapper: test migration, not feature removal

- [storage](../server/roleplayscene/scripts/storage.js), lines 684–688, wraps
  `prepareProjectImport` followed by `applyPreparedProjectImport`.
- Its only in-repo caller is
  [storage-persistence tests](../server/roleplayscene/tests/storage-persistence.test.mjs).
  Production [main](../server/roleplayscene/scripts/main.js) imports the two
  phases directly: published loading around line 2326, uploaded drafts around
  line 2621, and local import around line 2888. Local import confirms between
  prepare/apply and revokes candidate object URLs on cancellation.
- Do not delete wrapper-driven tests: they cover current/legacy ZIP, legacy
  manifests, plain JSON, media hydration, ID reseeding and invalid-input errors.
  Move those scenarios to the two production phases, retaining assertions and
  proving failed preparation leaves the current project/persistence unchanged.
- Existing explicit prepare/apply tests around lines 402–413 cover cancellation
  and confirmed replacement, but do not replace every wrapper scenario.
- Only then consider deleting the wrapper export, after checking external module
  consumers. Retain both phases, object-URL cleanup and all supported formats.

## Must retain: easily mistaken for dead code

| Area | Concrete active path / reason |
| --- | --- |
| Worksheet legacy JSON adapter | Viewer imports `mapLegacyJsonToPackageModel` from editor `worksheet-package.js` and calls it in its import path around line 3337. |
| Legacy worksheet audio | Editor local-open/import calls `collectLegacyAudioTargets` (around 1563/3223); viewer `resolveViewerAudioSources` still handles legacy refs used by prompt/option playback. |
| Shared package and ZIP code | Viewer and API `package-service.js` import editor helpers; API RolePlayScene package validation also imports editor ZIP helpers. Folder ownership is not usage ownership. |
| Shared voice workflow | Viewer imports it; RolePlayScene `player/discussion-state.js` and `player/ui.js` also import it. Keep recovery, undo, cancellation and cross-product tests. |
| Legacy RolePlayScene archives and IDs | `prepareProjectImport`/archive extraction handle older project JSON; `utils/id.js` accepts legacy IDs and is called during hydrate/import/state setup. |
| Legacy locale migration | RolePlayScene `main.js` reads the old locale key and migrates it to the active locale; old browser storage remains a supported input. |
| Shared auth popup | `server/app/login/popup.html` remains the shared callback; API client still targets `/worksheet_launcher/app/login/popup.html`. Not widget-only. |
| Audio in-flight markers | `restoreLegacyPromptInFlightMarker` / `restoreLegacyOptionInFlightMarker` are invoked by live generation/cleanup handlers and their state is read by rendering. Names alone do not justify removal. |
| Test-source loader | `rewriteModuleSourceForTests` is actively imported by editor/viewer tests, despite no production caller. Test infrastructure is not abandoned runtime. |
| Single-use function names | `requestHandler` is the function returned by `createRequestHandler`; `notifyOpener` is an invoked function expression in login HTML. Both are active despite lexical single references. |
| Widget boundary tests | Removed widget files should remain absent; retained entry/auth/API checks guard the retirement boundary. Do not delete these because the widget is gone. |

## Test-suite audit: preserve behavior, improve relevance

Inventory: **60 tracked `*.test.mjs` files**, distributed as API 13, shared app
12, editor 4, viewer 4, RolePlayScene 26, server scripts 1. There are **14 browser
`*-smoke.mjs` scripts** under `scripts/`, separate from `npm test`.

Eighteen RolePlayScene test files use top-level assertions rather than importing
`node:test`. Node still runs them and detects assertion failures; one reported
file subtest may cover many scenarios. They are not unused or empty tests, and
929 reported tests does not mean 929 independently named business scenarios.

Recommended test work, in a separate coverage-focused PR:

- Migrate B1/B2 tests to exercised runtime paths without dropping scenarios.
- Add behavioral confirmation/cancellation tests before replacing assertions in
  `import-safety-source.test.mjs` and `new-story-source.test.mjs`. String order
  does not prove the cancel branch avoids mutation or cleans up candidate URLs.
- Prefer rendered/runtime checks for source-string assertions in editor tests,
  e.g. upload-progress render deduplication around line 1125. Keep the current
  assertions until the replacement demonstrably catches the same regression.
- Retain source checks where the property is genuinely structural, such as
  forbidden widget imports. Avoid wholesale removal of source-based tests.
- Do not deduplicate frontend/backend validators solely because fixtures overlap:
  client authoring and server untrusted-upload validation are separate boundaries.
- No whole test-file deletion is recommended in this audit.

## Proposed implementation order and gates

1. **Small editor cleanup PR: A1 + A2 only.** Full Node suite, option-audio smoke,
   worksheet polish, replacement/load smokes, and a focused publish busy/retry
   check. Verify English/Traditional Chinese, desktop/mobile and keyboard focus.
2. **Artifact-helper/test PR: B1.** Strengthen real service call assertions first;
   remove only verified-unused exports and their wrapper-only assertions. Run full
   Node suite, including artifact isolation, auth/ownership and rollback tests.
3. **RolePlayScene import-test PR: B2.** Port every scenario before removing the
   wrapper. Run full Node suite and relevant RolePlayScene browser flows: import
   confirm/cancel/error, old formats/media, save/reload, published/draft loading,
   authoring and playback/discussion. Do not alter import behavior as cleanup.
4. **Coverage modernization**, only after the above: replace selected brittle
   source assertions with behavior checks, separately from functional fixes.

Each implementation PR should start from current `main-v1`, record the exact
deletion scope and retained behavior, pass CodeQL/review gates and report untested
areas. If a real bug is uncovered, stop classifying it as cleanup and propose a
focused fix with regression coverage. Keep rollback at a small PR/commit boundary.

## Reproducible checks

```sh
git rev-parse HEAD
git ls-files 'server/*.test.mjs' 'scripts/*-smoke.mjs'
git grep -n -E 'activePublishCount|optionAudioAttached|option-audio-attached'
git grep -n -E 'getRolePlaySceneDraftArtifactBucket|getRolePlayScenePublishedArtifactBucket|createRolePlaySceneDraftArtifactStoreInput'
git grep -n -E 'importProject|prepareProjectImport|applyPreparedProjectImport' -- server/roleplayscene scripts
git grep -n -E 'roleplayscene-package\.js|worksheet-package\.js|answer-voice-workflow\.js' -- server scripts
node --test
```

Run these commands from the repository root. `node --test` uses built-in test
discovery and also works on Node 20, whose test runner does not expand the quoted
glob used in the original Node 24 audit run. Browser smoke scripts are separate.

After adding this report, symbol searches also match this document; exclude
`docs/` when comparing code-only references. Revalidate against the implementation
PR baseline; the evidence above is pinned to the stated commit.
