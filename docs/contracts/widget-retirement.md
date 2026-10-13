# Active widget retirement boundary

Reviewed against main `7bb19de` on 2026-10-06. This reference replaces completed Step 1/2 PR instructions with the current compatibility boundary.

The repository no longer supplies `parent_prototype/parent.html`, its `sdk/parent-launcher.js`, or the renderer/widget assets under `server/worksheet_launcher/`. The old `w`, `rid`, `returnOrigin` launch protocol and `worksheetResult` exchange are historical. There is no replacement parent SDK, payload adapter or automatic redirect to the worksheet viewer.

Retain all worksheet editor, viewer and RolePlayScene behavior, including legacy package/JSON/audio input compatibility, local persistence, publishing, attempts, printing, playback, discussion and voice recovery. Retain:

- `server/app/login/popup.html` and deployed `/worksheet_launcher/app/login/popup.html`;
- `worksheet-launcher-auth-complete` and current session gating;
- product `/api/worksheet-launcher/v1/*` APIs;
- separate shared `/api/rewrite-bridge/rewrite`, `/transcriptions`, `/t2a` services;
- active locale/print preferences and stored user content.

The similar login URL prefix does not make shared auth widget-only. Model-status pollers in the retired widget are not current product dependencies, but the external bridge configuration is outside this repository. No storage cleanup, prefix removal, database change or external service retirement follows from archiving its documents.

`server/app/widget-removal-boundary.unit.test.mjs` guards retired-file absence and retained entry/client behavior. It is a structural tripwire, not proof that dynamically configured deployments or external parent copies have been inventoried. For a future deployment touching this boundary, inspect the exact aliases/static releases/external integrations, record the deployed rollback revision, preserve environment/storage and run retained-product live QA. Use the [testing guide](../operations/testing.md).

The [Step 1 record](../past/widget/widget-removal-step1.md) and [Step 2 record](../past/widget/widget-removal-step2.md) preserve the original deletion scope, test reports and historical rollback baseline. Do not use their old branch/commit or test counts as today's deployment instructions.
