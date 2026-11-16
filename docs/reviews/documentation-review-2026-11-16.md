# PR2 cleanup and documentation alignment — 2026-11-16

Baseline: PR #349, `codex/preview-attempt-lifecycle`, commit
`99ba300be56d8e920b593219c63d51c856f4a40f`. PR2 branches from and targets that
branch. This is a source/review record, not a merge, VPS deployment or live
acceptance record. The [documentation index](../README.md) remains authoritative.

## Scope and removal evidence

The review covers worksheet editor, viewer, RolePlayScene and shared browser/API
consumers. Literal import tracing is only a starting point: event handlers,
protected action IDs, persisted intent restoration, package adapters and tests
were checked before selecting removals.

| Removal | Evidence and preserved behavior |
| --- | --- |
| Editor legacy prompt-audio DOM row and its exclusive error/label helpers | The row was constructed but never mounted; actual controls are the language-track rows. Retain their generation locks, eligibility/stale hints, Cancel, confirmations and legacy audio handlers. The live hint now has its own block-bound reference. |
| Editor unused `consumeNotification` and local `optionHasContent` import | No callers for the method; notification synchronization remains active. The shared option validator still uses its own `optionHasContent` import. |
| Viewer `rewriteMessageByBlock`, setter, empty paragraph and exclusive CSS | No setter calls. Actual errors, recovery and sign-in feedback belong to the shared voice UI/workflow. Retain answer cache, Undo, recovery persistence, operation panel and imported-ID handling. |
| RolePlayScene `messageBySceneId`/getter/snapshot entry | Only empty-string writes; no nonempty producer and no persistence contract. Keep save-failure hints, shared voice errors, discussion/Undo/recovery and print snapshots. |
| `classifyProtectedUploadResult` and its exclusive unit case | No production consumers. Keep `classifyUploadResult`, upload receipts/conflicts/slots/cancellation, mutation preparation and legacy auth-gate compatibility. |

The editor source assertions now refer to the mounted language tracks rather than
requiring the unmounted row to exist. The removed upload-envelope test exercised
only the unused helper; active auth/consumer tests remain. Special imported scene
IDs still exercise rewrite, Undo, persisted recovery and retry.

Retained deliberately: legacy audio/JSON/ZIP adapters, protected-action replay and
restoration entry points, test-used session wrappers, the RolePlayScene audio
phase-timeout policy module, package parsers used by the API, active localization,
shared voice and all storage keys. No dependencies, package versions, routes,
migrations or supported product features are removed. Larger `main.js`
modularization is separate work after this cleanup/acceptance.

## Documentation disposition

The baseline contains 78 tracked Markdown documents: 22 under `docs/past/` and
56 elsewhere. Correct maintained content is retained; changing every file is not
an objective. Original dated test evidence and legal/provenance text are preserved.

| Document group | Review and disposition |
| --- | --- |
| Root README, AGENTS and both UI skills | Preserve compatibility/testing rules and distinct authoring/player layouts. Clarify stacked branches; replace obsolete pending Version C guidance with current behavior. |
| Documentation index and runtime architecture | Pin the reviewed PR1 baseline, document temporary preview and normal Resume ownership, link long text/rich editor/current viewer guidance, distinguish implementation from deployment. |
| Local models, package formats and message contract | Reconcile six question types, blank checking, optional feedback and provider-return behavior. Preserve versions, legacy import policy, full attempt snapshots, normal/preview lifecycle and reference-safe cleanup. Prompt-length publishing policy remains separate from blocking distribution readiness. |
| Authentication foundation/workflows/reads/mutations and bridge | Replace the stale target/migration roadmap with current continuation/ownership rules. Archive the original auth mapping. Preserve detailed bridge history with its explicit historical labels, current deadlines and active legacy adapters. |
| Upload snapshots/recovery, publication/deletion, editor-viewer backend contract | Correct editable attempt naming, explicit viewer slot continuation, shared-client versus page-adapter ownership and current error/auth presentation. Preserve receipt and uncertain-mutation rules. |
| Worksheet replacement, loading, voice, Markdown, rich editor, image response, blanks, long text, feedback and reorder guides | Correct close/cancel flow, busy cleanup, print content, shared operation panel, green audio attachment state and completed-feature status. Preserve limits, preview isolation, compatibility, feedback visibility and type-specific voice/printing rules. |
| Viewer staged plan and four validation/implementation records | Archive the original plan and replace its maintained path with current guidance. Clearly label continuous/Version C/motion/refinement reports as historical evidence; retain measurements and acceptance claims at their original dates. |
| RolePlayScene guides | Preserve exact scene IDs, naming, title compatibility, dialogue order, project import/copy/publication and player/music/discussion semantics. Clarify the 15-second individual session probe versus separate 120-second outer preparation/provider deadlines and implemented T2A integration. |
| Operations/testing/localization/server runtime | Correct obsolete suite counts, unused-classifier coverage and upload/auth replay prose. Retain actual endpoint/configuration ownership, structured error presentation and local versus live acceptance boundaries. |
| Database, artifact maintenance and test-data cleanup | SQL remains through migration 015. Configuration/maintenance/test-cleanup implementations are unchanged from their documented baseline; retain commands, destructive-action boundaries and artifact/receipt limitations. PR2 runs no maintenance against user data. |
| Colocated contracts, fonts, reference workspace and third-party notices | Clarify active cross-consumer contract ownership; retain font provenance, licenses, pinned build dependencies and local-reference policy. |
| Original `docs/past/` records and 2026-10-06 review | Keep dated evidence and archive authority unchanged. Add the two newly archived records with links to their maintained replacements. No historical proposal becomes an approved next feature. |

## Verification boundaries

Required automated checks: full Node suite, all retained browser smoke scripts,
CI-runner tests, reproducible editor bundle check, diff whitespace, relative links
and Markdown anchors. Browser fixtures cover English/Traditional Chinese and
wide/narrow layouts with synthetic auth/media/providers. Review actual screenshots
for the affected editor audio, viewer voice and RolePlayScene discussion surfaces.

Current run results are recorded in the PR description; old reports elsewhere do
not count as this PR's test execution. Real VPS/OIDC/provider/device acceptance
is still the user's combined-stack deployment step. No production data, external
bridge configuration or VPS service is changed by this PR.
