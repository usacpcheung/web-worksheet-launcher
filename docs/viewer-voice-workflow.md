# PR 2: incremental voice answers

Base: `main-v1`, after voice foundation PR #272 (`9ee9304`). Keep this PR on
`codex/viewer-voice-workflow` until review and VPS/device acceptance are complete.
Do not merge or deploy automatically.

## Learner behavior

- Editable text questions offer **Add by voice**. The pipeline records, transcribes,
  rewrites only the new transcript, and inserts the result without a preview.
- Additions append by default. A deliberate cursor placement inserts there; a
  selection inserts after the selection and does not replace selected text.
  Successful insertion/cancellation clears the placement intent.
- The target answer is read-only throughout checking, capture and processing.
  Stage messages, elapsed recording time, Stop and Cancel appear inline.
- One voice or whole-answer rewrite runs per attempt. Next/Back during recording
  stops capture and processes the original question. Navigation during network
  work leaves that work attached to its original question. Another question stays
  editable, with a compact explanation and View/Cancel controls; its voice/rewrite
  buttons are disabled. Background completion does not move focus from that question.
- Submit is blocked while an operation is active. Cancel unlocks immediately and
  rejects late results, even if an underlying transport ignores cancellation.
  Cloud work already accepted may still finish; no automatic retries are made.
- Whole-answer Rewrite remains explicit. Undo restores the exact previous answer.
  Manual typing never triggers rewriting.

## Limits, recovery and privacy

- The PR 1 recorder stops near one minute (59.5 seconds to allow finalization);
  recordings beyond 60 seconds and uploads over 20 MiB are rejected.
- Rewrite input is limited to 2,000 Unicode code points. The existing worksheet
  answer limit remains separate and uses UTF-16 length. Oversized additions are
  retained in an editable recovery area, never truncated into the answer.
- Session readiness is checked before requesting microphone permission. Sign-in
  uses the existing flow and requires another explicit click; it never starts
  recording automatically. Audio retained after an upload authentication failure
  exists only in memory and is released on discard, teardown or a replacement task.
- A transcribed segment is saved immediately as local attempt recovery before
  rewrite. Editing recovery follows normal autosave. If local storage fails, the
  existing save-error indicator applies; persistence cannot be guaranteed then.
- Reload restores raw text for review/rewrite, not audio or a rewritten candidate.
  Retry after transcription does not upload/transcribe again. Recovery is excluded
  from attempt packages, uploads and print. Completion/discard clears recovery.
- Attempt/snapshot identity, answer snapshot and editability are checked before
  applying results. Changed answers require explicit recovery at the end.
- Student messages use short error categories and do not expose upstream bodies.
  This workflow does not log transcripts, audio or candidate text.

## Configuration and deployment

No new environment variables, dependencies, migrations or backend routes are
introduced. PR 1's bridge transcription/rewrite routes and session configuration
must already work. Microphone capture requires HTTPS (or localhost) and permission.
Frozen popup widgets, RolePlayScene, launch hashes and postMessage contracts are
unchanged.

No arbitrary client network deadline was added: the deployed proxy/bridge timeout
values have not been inspected. A stalled request stays visibly pending until
Cancel or transport failure. Verify deployed limits and slow/stalled connections
on the VPS before merging; tune any future deadline against those measured limits.

## Automated verification

Run `npm test` for the full suite. For the browser regression, start the static
server in one terminal and run the following in another:

```sh
node scripts/static-server.mjs
```

```sh
node scripts/viewer-voice-smoke.mjs
```

`VIEWER_SMOKE_URL` can override `http://127.0.0.1:8765`.
`VIEWER_SMOKE_SCREENSHOTS` optionally specifies a screenshot output directory.
The smoke uses an isolated browser context with synthetic microphone and API
responses; it makes no paid transcription/rewrite calls. It checks cross-question
completion, focus, selection insertion, default append after success, Undo, narrow
layout, recovery editing/reload, rewrite-only retry, and edits after navigation.

## Required acceptance before merge

Automated tests do not establish real microphone/provider/device compatibility.
Use the feature branch on the VPS and test Windows Chrome/Edge, actual iPad Safari
and mobile Chrome. Live provider calls require explicit authorization.

- Record a short answer: append, caret insertion, selection-end insertion, repeat
  after typing, and Undo. Confirm earlier text is preserved.
- Deny microphone permission; then allow it. Test sign-in before capture and
  session expiry during upload/rewrite. No surprise recording after sign-in.
- Navigate from Question 1 during recording, transcription and rewriting. Type
  on Question 2; check the explanatory status, View/Cancel and disabled controls.
  Return to Question 1; confirm the correct answer changed and later edits survive.
- Throttle the network, disconnect, cancel, and retry. Check no duplicate automatic
  requests, late insertions, indefinite lock after Cancel, or focus jumps.
- Exercise the one-minute stop, oversized transcript, combined answer overflow,
  editable recovery, local save/reload, discard, submission and exported package.
- Check Chinese/English messages, keyboard navigation, mobile portrait/landscape,
  browser backgrounding and fixed-bottom-bar clearance. Confirm no voice controls
  on number/boolean/choice questions or completed attempts.
- Inspect VPS service/proxy logs for request failures without sharing learner
  content or credentials. Confirm existing worksheet, audio and RolePlayScene flows.

Rollback during acceptance: return the VPS checkout to the previously validated
`main-v1` revision (`9ee9304`) and use the normal service/cache refresh procedure.
This PR introduces no database migration to reverse.
