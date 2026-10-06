# Testing the current products

Reviewed against main `7bb19de` on 2026-10-06. Test commands come from `package.json` and tracked `scripts/*-smoke.mjs`, not historical PR test counts.

## Node checks

```bash
npm test
```

This runs `node --test "server/**/*.test.mjs"`. Use a Node version supporting that quoted test glob (the historical Node 24 runs do); on older Node versions, `node --test` uses native discovery. Tests include API/ownership/package/storage, local contracts, auth, text, audio and product behavior. Some RolePlayScene files use top-level assertions and still execute through the test runner.

For a documentation-only edit, validate scope, relative links, consistency and skill references. Run existing tests that actually read changed documentation: `node --test server/app/login/popup.unit.test.mjs` reads the stable `docs/message-contract.md` path. Do not claim a new browser/provider run merely because an archived document reports one.

## Browser smoke setup

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

The table inventories all 26 current smoke scripts; it does not claim they were run for this documentation review. `npm test` does not run them. Check shared consumers too: worksheet package/audio helpers serve the viewer/API, and viewer voice processing also serves RolePlayScene discussion.

Browser fixtures use isolated storage and synthetic/mocked auth, API and audio where documented by each script. Never point synthetic/destructive fixtures at production learner records. Verify both supported locales, desktop/narrow layouts, keyboard focus and browser errors for affected UI.

## Deployment acceptance

Local tests do not certify live OIDC/proxy configuration, database installation, paid provider support, real microphones, physical iPad/mobile behavior, screen readers or every browser. Deployment acceptance should cover real HTTPS sign-in, draft save/restore, publish/load, attempts/review, audio playback/voice and RolePlayScene branches/music/discussion. Record exact releases and use test copies. Live provider calls and deployment are separate actions from local validation.

The [archived audits](../past/README.md) preserve historical results and limitations; current counts and readiness must come from a new run on the branch being reviewed.
