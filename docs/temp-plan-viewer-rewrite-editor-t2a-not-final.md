# Temporary Draft Plan: Viewer Rewrite + Editor T2A

Status: temporary working draft, not finalized.

## Summary

Replace the current global rewrite/T2A stub buttons with context-aware actions that match the intended product flow:

- `Rewrite` exists only in the viewer, only for `text` response questions, and rewrites the learner's current answer in place with a one-step undo.
- `T2A` exists only in the editor, for question prompts and multiple-choice options, and generates an MP3 that is attached through the existing question/option audio model.
- Both features use the same Google OIDC session model already used by this project; the browser must call same-origin OIDC-protected bridge routes and must never send trusted bridge headers directly.

## Key Changes

### Shared bridge/auth integration

- Add shared frontend bridge-client methods in `server/app/api/server-api-client.js` for:
  - rewrite: `POST /api/rewrite-bridge/rewrite` with `{ text, stream: false }`
  - T2A: `POST /api/rewrite-bridge/t2a` with binary response, `format: "mp3"`, `response_mode: "binary"`
- Keep `credentials: "include"` and rely on Apache/reverse-proxy header injection for bridge auth.
- Reuse `SharedAuthGate` protected-action replay instead of inventing a second login flow.
- Pending protected intents must carry exact target metadata so post-login replay resumes the original action, not a generic stub.

### Viewer rewrite behavior

- Remove the current viewer utility-menu stub action `Rewrite Assist (Sign-in required)`.
- Add an inline `Rewrite` action beside the active answer control only when all are true:
  - current block is a question
  - `responseConfig.inputType === "text"`
  - attempt status is not `completed`
  - current answer is non-empty
- Add inline `Undo` after a successful rewrite; it restores the pre-rewrite answer for that block only.
- Rewrite applies the returned text directly into the current answer field and reuses existing text-counter / max-length behavior. No separate preview modal.
- Undo state is one level only and is cleared when the learner manually edits the answer or runs rewrite again.
- Client-side limit rule:
  - spaced text: hard block above `300` words
  - no-space text (for example Chinese): hard block above `300` characters
- Logged-out click path:
  - trigger existing sign-in flow
  - replay rewrite for the same `localAttemptId + blockId`
  - keep the current answer intact if auth or API fails

### Editor T2A behavior

- Remove the current global editor `Rewrite` and `T2A` stub buttons from the protected-actions column.
- Do not add any editor rewrite feature in this scope.
- Add `Generate audio` / `Regenerate audio` to the question prompt audio row for every question block.
- Add `Generate audio` / `Regenerate audio` to the multiple-choice option actions menu, only for persisted non-empty options.
- T2A generation uses server/default voice settings only; no teacher-facing voice/speed/pitch UI in v1.
- On success, attach the returned MP3 through the existing local asset path:
  - question prompt -> `question_audio`
  - MC option -> `option_audio`
- Reuse existing replace/play/remove/export/import behavior by routing generated audio through the same attachment methods already used for manual uploads.
- If audio already exists, require the same explicit replace confirmation before overwriting.
- If generation fails, leave existing audio untouched and show normal editor feedback.

### Data model and docs

- No popup launch-hash or popup `postMessage` schema changes are planned.
- `server/worksheet_launcher/widgets/rewrite-widget.js` remains untouched.
- No worksheet/package schema change is needed; generated MP3s reuse the existing asset model and `mediaRefs`.
- Internal/frontend interface additions:
  - bridge client methods for rewrite and T2A
  - protected intent payloads:
    - viewer rewrite: `{ localAttemptId, blockId }`
    - editor prompt T2A: `{ localDraftId, blockId, target: "question_prompt" }`
    - editor option T2A: `{ localDraftId, blockId, target: "option", optionId }`
- Update runtime docs/spec notes for editor/viewer AI-assist behavior and bridge route expectations.
- `docs/message-contract.md` stays unchanged unless implementation ends up changing popup auth-callback or popup transport contracts.

## Test Plan

- Viewer shows rewrite only for `text` questions and hides it for `number`, `boolean`, `multiple_choice`, content blocks, and completed attempts.
- Viewer rewrite replaces the answer in place, updates existing counters/status text, and undo restores the exact prior answer.
- Manual edit after rewrite clears undo state.
- Viewer rewrite blocks over-limit input using the agreed `300 words / 300 chars for no-space text` rule.
- Logged-out viewer rewrite triggers auth, restores the same attempt, and replays rewrite for the same block after login.
- Editor question-prompt T2A generates and attaches playable MP3 as `question_audio`.
- Editor MC option T2A generates and attaches playable MP3 as `option_audio`, and remains disabled for empty/unpersisted placeholder options.
- Replace-confirm flows preserve current audio when cancelled.
- T2A/rewrite API failures do not destroy existing text/audio and surface clear feedback.
- Export/import/viewer playback still work for generated audio because package/media wiring is unchanged.

## Assumptions and Defaults

- Public bridge routes are available same-origin under `/api/rewrite-bridge/*` and share the project's Google OIDC session.
- Browser clients never send `X-Bridge-Auth` or `X-Authenticated-Email`; the reverse proxy injects them.
- Rewrite uses non-stream mode only in this phase.
- T2A uses binary MP3 output only in this phase.
- Generated local asset metadata may mark origin as T2A-generated for debugging, but exported package structure stays unchanged.
