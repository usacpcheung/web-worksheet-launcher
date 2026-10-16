# Testing the current products

Test commands come from `package.json`, the [regression workflow](../../.github/workflows/regression.yml), and tracked `scripts/*-smoke.mjs`, not historical PR test counts. CI setup was added against main `7b22cad` after PR #304.

## Automated pull request checks

The `Regression` GitHub Actions workflow runs on every pull request, pushes to `main`, and manual dispatch. It uses Ubuntu 24.04, Node 24, `npm ci`, the Chromium build matching the locked Playwright version, and a disposable PostgreSQL 17 service. It requires no repository secrets or production services. Pull requests use the ordinary `pull_request` event with a read-only token; checkout does not persist credentials.

Jobs run the complete Node suite, CI runner behavior tests, all discovered `scripts/*-smoke.mjs` across three browser shards, and the PostgreSQL fixture below. New smoke scripts with that suffix are included automatically. No path filters skip documentation-only PRs. A newer run for the same PR/branch cancels an older run.

The final **Regression gate** passes only when Node, all browser shards and PostgreSQL succeed; failures, cancellations and skipped suites cannot pass the gate. After validating the workflow on GitHub, configure `Regression gate` as a required status check in the `main` branch ruleset/protection settings. Adding a workflow file alone does not enforce branch protection. Keep this check name stable. If merge queue is enabled later, also add the `merge_group` workflow event before requiring it in that queue.

Each run uploads diagnostics retained for seven days: Node output, PostgreSQL fixture/server logs, and browser per-script logs, `summary.json` and screenshots produced by the individual scripts. Browser logs include Playwright API diagnostics (`DEBUG=pw:api`). These are synthetic test artifacts; they do not include a production session. Screenshots are script-defined checkpoints, not guaranteed captures at the instant of every failure. Download the corresponding artifact from the workflow run to investigate.

## Node checks

```bash
npm test
```

Use Node 24 and run `npm ci` first. `npm test` runs `node --test "server/**/*.test.mjs"`. Tests include API/ownership/package/storage, local contracts, auth, text, audio and product behavior. Some RolePlayScene files use top-level assertions and still execute through the test runner. `npm run test:ci-runner` separately verifies shard coverage, child failure reporting and timeout cleanup.

For a documentation-only edit, validate scope, relative links, consistency and skill references. Run existing tests that actually read changed documentation: `node --test server/app/login/popup.unit.test.mjs` reads the stable `docs/message-contract.md` path. Do not claim a new browser/provider run merely because an archived document reports one.

## Upload-result regression coverage

`server/app/api/upload-result.test.mjs` checks resource-specific result
classification, original-result preservation, malformed inputs, authentication
metadata on transport failures, and the auth-gate envelope boundary. Editor,
viewer and RolePlayScene caller tests load the real shared classifier. Keep
`editor-upload-result-smoke.mjs`, `attempt-upload-recovery-ui-smoke.mjs`,
`upload-cancellation-ui-smoke.mjs`,
`upload-operation-smoke.mjs`, `upload-http-errors-smoke.mjs` and RolePlayScene
save/recovery checks when changing this boundary. These use isolated fixtures;
they do not establish real VPS or identity-provider acceptance. Cross-application
refactors require the full Node and retained browser suites.

## Browser smoke setup

To reproduce the full CI browser suite locally:

```bash
npm ci
npx playwright install --with-deps chromium
npm run test:browser
```

The runner starts and checks its own static server on an available loopback port, gives each script a separate Node/browser process, then stops the server. It overrides `VIEWER_SMOKE_URL` and `ROLEPLAYSCENE_URL` to use this local fixture. No manually started server is needed. It continues after a script failure to collect other results and exits nonzero if any script fails, times out, or the run is interrupted.

For one failed script or a CI shard:

```bash
npm run test:browser -- review-fixes-smoke.mjs
npm run test:browser -- --shard=2/3
```

Diagnostics go to a new `artifacts/browser/run-*` directory each time, avoiding stale screenshots/results; `artifacts/` is ignored by Git. Set `SMOKE_ARTIFACT_DIR` to choose a different output root. The per-script deadline defaults to five minutes; `SMOKE_TIMEOUT_MS` overrides it for local debugging. Timed-out process groups, including browser descendants on Linux, are terminated. The workflow also has job-level timeouts.

To run a script directly without the runner:

```bash
npm run pw:install
npm run serve:static
```

Then run an affected smoke in another terminal, for example:

```bash
node scripts/worksheet-markdown-smoke.mjs
```

The ordinary static server defaults to `http://127.0.0.1:8765`. Read each script before running: some own fixture servers; `editor-replacement-smoke.mjs` has a different default and needs `VIEWER_SMOKE_URL=http://127.0.0.1:8765` when using the ordinary server. Where supported, use `VIEWER_SMOKE_SCREENSHOTS` outside the tracked repository.

## Choose checks by affected behavior

| Area | Existing browser scripts under `scripts/` |
| --- | --- |
| Worksheet text/print/navigation | `worksheet-markdown-smoke.mjs`, `worksheet-polish-smoke.mjs`, `viewer-completed-review-smoke.mjs`, `viewer-imported-ids-smoke.mjs` |
| Worksheet ordering | `editor-reorder-smoke.mjs`, `editor-drag-reorder-smoke.mjs` |
| Worksheet loading/replacement | `editor-load-progress-smoke.mjs`, `editor-replacement-smoke.mjs`, `viewer-package-load-progress-smoke.mjs` |
| Worksheet audio/voice | `editor-voice-choice-smoke.mjs`, `editor-option-audio-smoke.mjs`, `viewer-voice-smoke.mjs` |
| Shared sign-in UI | `package-sign-in-style-smoke.mjs` |
| RolePlayScene general/import/persistence | `roleplayscene-smoke.mjs`, `roleplayscene-confirmation-smoke.mjs`, `roleplayscene-autosave-smoke.mjs`, `roleplayscene-save-recovery-smoke.mjs` |
| RolePlayScene loading/copy | `roleplayscene-edit-copy-smoke.mjs` |
| RolePlayScene identity/title/layout | `roleplayscene-scene-name-smoke.mjs`, `roleplayscene-scene-name-state-smoke.mjs`, `roleplayscene-project-title-smoke.mjs`, `roleplayscene-intro-layout-smoke.mjs` |
| RolePlayScene ordering/audio/discussion | `roleplayscene-dialogue-order-smoke.mjs`, `roleplayscene-voice-choice-smoke.mjs`, `roleplayscene-voice-smoke.mjs`, `roleplayscene-music-navigation-smoke.mjs` |

The table inventories the 26 retained-product smoke scripts. `review-fixes-smoke.mjs` additionally forces unfinished IndexedDB writes across reload and exercises upload cancellation in all three products, post-upload refresh cancellation in editor/RolePlayScene, both locales and desktop/narrow layouts. It also simulates concurrent IndexedDB saves, deletes and clears between recovery reads and writes, including equal timestamps. `npm test` does not run them. Check shared consumers too: worksheet package/audio helpers serve the viewer/API, and viewer voice processing also serves RolePlayScene discussion.

`upload-operation-smoke.mjs` covers real browser XHR response loss for all three upload APIs, immediate and late-commit status recovery, URL-encoded metadata fingerprints, bounded unknown status without a POST resend, and cancellation during lookup. The runner discovers it automatically alongside the existing 27 scripts.

`upload-http-errors-smoke.mjs` adds a real local HTTP server that flushes response headers before stalling or disconnecting the body. It checks 401/403/409/413/429 rejections, uncertain 200/503 responses and non-JSON replies in Chromium, including the XHR status reset after headers. Together these bring the automatically discovered browser suite to 29 scripts.

Browser fixtures use isolated storage and synthetic/mocked auth, API and audio where documented by each script. Never point synthetic/destructive fixtures at production learner records. Verify both supported locales, desktop/narrow layouts, keyboard focus and browser errors for affected UI.

## Transaction and concurrency regression fixture

With `REVIEW_TEST_DATABASE_URL` set to a disposable PostgreSQL database, run:

```bash
npm run test:postgres
```

The script creates a unique temporary schema, applies all repository migrations, and uses temporary artifact files. It simulates a real database commit followed by loss of its acknowledgment, replacement/delete lock contention, and six simultaneous uploads against the three-slot limit. It drops its schema and removes its files afterward. Do not point it at production. Node service tests separately inject acknowledgment loss into all five artifact-producing operations and check missing-row replacement cleanup.

Its upload-operation fixtures also run six concurrent identical requests for each upload type, verify one row/file and stable replay, reject changed bytes/metadata/kinds, check owner isolation, replay copies and replacements (including published drafts), preserve receipts after deletion, verify that uncommitted receipts remain unknown, recover a lost commit reply, and roll back resource/file changes when receipt insertion fails. They also race different payloads for one key, replay with full slots, reject malformed packages without receipts, preserve the original row/ZIP after a replacement receipt failure, and delete a draft while its replacement ZIP is being written. A real HTTP fixture joins the shared fetch client, API routing, PostgreSQL and filesystem: the POST socket closes before commit, the first status read is unknown, and a later poll recovers the committed receipt without resending the ZIP.

For a disposable local database matching CI (Docker required):

```bash
docker run --rm -d --name worksheet-ci-postgres \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=fixture-only -e POSTGRES_DB=worksheet_ci \
  -p 127.0.0.1:55432:5432 postgres:17-alpine
```

Wait until `docker exec worksheet-ci-postgres pg_isready -U postgres -d worksheet_ci` reports accepting connections, then run:

```bash
REVIEW_TEST_DATABASE_URL=postgresql://postgres:fixture-only@127.0.0.1:55432/worksheet_ci npm run test:postgres
docker stop worksheet-ci-postgres
```

Stop the container after failed runs too; forced termination may skip fixture cleanup, but removing the disposable container discards its database.

## Deployment acceptance

Local tests do not certify live OIDC/proxy configuration, database installation, paid provider support, real microphones, physical iPad/mobile behavior, screen readers or every browser. Deployment acceptance should cover real HTTPS sign-in, draft save/restore, publish/load, attempts/review, audio playback/voice and RolePlayScene branches/music/discussion. Record exact releases and use test copies. Live provider calls and deployment are separate actions from local validation.

The [archived audits](../past/README.md) preserve historical results and limitations; current counts and readiness must come from a new run on the branch being reviewed.

## Upload-recovery simulation coverage

`server/app/api/upload-operation-failure-matrix.unit.test.mjs` exercises all three upload APIs through fetch and XHR. It covers normal success, connection resets, stalled headers/bodies, interrupted bodies, malformed JSON, gateway/server errors, authentication, conflicts, size/rate-limit rejections and login HTML. Additional cases cover a shared polling deadline, cancellation during backoff, unsupported status endpoints, missing crypto capabilities, uppercase UUIDs, and Blob/ArrayBuffer/offset-view inputs. `upload-operation-recovery.unit.test.mjs` checks delayed commit visibility, transient status errors, exact metadata/byte matching, caller mutation and mismatched receipts.

These are isolated automated simulations. They do not validate production Apache/OIDC configuration, a live deployment's migration state, Safari/Firefox behavior, physical disk or host failure, or recovery after a page reload. Commits later than the recovery budget can remain unknown; receipt retention, durable retry UI, publishing idempotency, server cancellation and orphan reconciliation retain the boundaries described in the [runtime reference](server-runtime.md#upload-operation-ids-and-recovery).

### Upload lifecycle regressions

`upload-operation-lifecycle.test.mjs` tests exclusive ownership, abort reservation, stale progress and cleanup. Product unit tests cover cancellation or record replacement during preparation and stale editor feedback. `scripts/upload-lifecycle-ui-smoke.mjs` exercises repeated clicks during session preflight and conflict dialogs, then a fresh upload after cancellation, in English and Traditional Chinese at desktop and narrow widths. The existing cancellation, recovery and upload-result smoke scripts cover the shared consumers.

The lifecycle browser fixture also replaces the viewer attempt during held session preflight, both with the same ID and a different ID, then releases successful, 503 and 401 responses. It asserts zero stale upload POSTs and preservation of the replacement message in both locales. Shared auth-gate tests cover invalidation during preflight, late authentication failure and local persistence, with no stale pending intent or redirect.
