# Temporary Draft Plan: Viewer Rewrite + Editor T2A

Status: temporary working draft, not finalized.

## Summary

Replace the current global rewrite/T2A stub buttons with context-aware actions that match the intended product flow:

- `Rewrite` exists only in the viewer, only for `text` response questions, and rewrites the learner's current answer in place with a one-step undo.
- `T2A` (Generate audio) exists only in the editor, for question prompts and multiple-choice options, and generates an MP3 that is attached through the existing question/option audio model.
- Both features use the same Google OIDC session model already used by this project; the browser must call same-origin OIDC-protected bridge routes and must never send trusted bridge headers directly.

The current stub buttons (`Rewrite Assist (Sign-in required)` in the viewer utility menu, and `Rewrite (Sign-in required)` / `T2A (Sign-in required)` in the editor protected-actions column) are removed outright. They are replaced by contextual inline buttons that only appear when the feature is actually usable. There is no menu-toggle approach — the inline buttons are the final UI; stubs serve no further purpose once sessions are working.

---

## Input Constraints

### Rewrite (viewer)

The 300 limit is a **character limit applied to the trimmed answer text**, not a word count. The rule is:

- `trim(answerText).length > 300` → disable the Rewrite button and show an inline hint: `"Answer is too long to rewrite (max 300 characters)."`
- There is no separate word-count heuristic and no special handling for scripts without spaces (e.g. Chinese). All languages use the same character count on the trimmed string.
- This limit is about what the rewrite API can reliably process, not about the viewer's existing `maxLength` constraint. The two limits are independent:
  - `maxLength` is the answer storage limit set by the content author and enforced by the text counter.
  - The 300-char rewrite limit is a client-side API input guard. If `maxLength < 300`, the rewrite button is only shown/enabled when the answer is non-empty and within `maxLength`; the 300-char check is then redundant but still applied.
- The disable state (not a hard runtime block) is the correct UX pattern here — matching the existing `text-counter` warning/over pattern.

### T2A (editor)

- The default maximum input length for the T2A bridge call is **200 characters** (trimmed).
- Applies to: question prompt text and individual MC option label/value text.
- `trim(sourceText).length > 200` → disable the `Generate audio` button for that row and show an inline hint: `"Text is too long to generate audio (max 200 characters)."`
- `trim(sourceText).length === 0` → button is also disabled with no hint (empty input has no audio to generate).

---

## Button Placement

### Viewer — Rewrite and Undo

The `Rewrite` and `Undo` buttons appear **below the text answer input, right-aligned**, as a small action row beneath the text counter line. This keeps them physically connected to the input they affect.

Layout sketch for a `text` question block in active state:

```
┌─────────────────────────────────────────┐
│ [textarea — learner's answer]           │
└─────────────────────────────────────────┘
  42/200                    [Undo] [Rewrite]
```

- `Rewrite` is always shown when conditions are met (see visibility rules below).
- `Undo` only appears after a successful rewrite and is hidden once the learner manually edits or rewrites again.
- Both buttons are hidden entirely outside their conditions — not disabled and greyed out in that row.
- When a rewrite call is in flight, `Rewrite` shows a loading label (e.g. `"Rewriting…"`) and is disabled; `Undo` is also disabled during this time.

Visibility rules for `Rewrite`:

- block kind is `question`
- `responseConfig.inputType === "text"`
- attempt status is not `completed`
- `trim(answerText).length > 0`
- `trim(answerText).length <= 300`

### Viewer — Stub removal

Remove `rewriteAssistBtn` (`Rewrite Assist (Sign-in required)`) from the utility menu list entirely. Do not replace it with a toggle. The utility menu only retains `syncResumeBtn` and `printReportBtn`.

### Editor — Generate audio and Regenerate audio

The `Generate audio` / `Regenerate audio` button appears **in the existing question audio row** and **in the MC option actions area**, right-aligned alongside the existing `Attach audio…` / `Replace audio…` button.

Layout sketch for question audio row:

```
Audio:  [♪ Attach audio…]  [Generate audio]  [▶ Play]  [✕ Remove]
```

When audio already exists:

```
Audio:  [♪ Replace audio…]  [Regenerate audio]  [▶ Play]  [✕ Remove]
```

When generation is in flight, the `Generate audio` / `Regenerate audio` button shows `"Generating…"` and is disabled. All other audio row buttons are also disabled during generation to prevent race conditions.

### Editor — Stub removal

Remove `rewriteBtn` (`Rewrite (Sign-in required)`) and `t2aBtn` (`T2A (Sign-in required)`) from `protectedActionsColumn` entirely. The `signInBtn` and server session management controls remain as-is.

---

## Key Changes

### 1. Bridge client — API and contracts

**Bridge base URL**

The bridge routes live under `/api/rewrite-bridge/*`, which is a completely different prefix from the existing `publicApiBase` (`/api/worksheet-launcher/v1`). The bridge base URL must be hardcoded as a module-level constant in `server-api-client.js`:

```js
const BRIDGE_API_BASE = '/api/rewrite-bridge';
```

This constant must never be derived from `options.apiBase` or the URL query string (`?apiBase=...`). The `buildUrl()` helper must not be reused for bridge paths — bridge URLs are built with `BRIDGE_API_BASE` directly.

**New `requestBinary` helper**

`requestZip` cannot be reused for T2A because it validates for `application/zip`. Add a new private helper `requestBinary(path, expectedMime, request)` that:

- Calls `fetch` with `credentials: "include"`.
- On non-ok response, handles 401/403 as `AUTH_REQUIRED` (matching the existing pattern).
- On ok response, validates `content-type` matches `expectedMime`; if not, returns `UNEXPECTED_CONTENT_TYPE`.
- Validates the response body is non-empty (`ArrayBuffer.byteLength > 0`); if zero bytes, returns `BRIDGE_EMPTY_RESPONSE`.
- Returns `{ ok: true, data: Uint8Array, status }` on success.

**New bridge client methods**

Add to `createServerApiClient` return object:

```js
rewriteText(text) {
  // POST BRIDGE_API_BASE + '/rewrite'
  // body: { text: String(text), stream: false }
  // response: JSON { ok: true, data: { text: string } }
  // validate: result.data.text must be a non-empty string after trim
}

generateAudioFromText(text) {
  // POST BRIDGE_API_BASE + '/t2a'
  // body: { text: String(text), format: "mp3", response_mode: "binary" }
  // response: binary MP3 (audio/mpeg)
  // uses requestBinary(path, 'audio/mpeg', ...)
}
```

Both methods return the standard structured error format (`{ ok, error }`) on any failure path.

**Rewrite response validation**

After a successful HTTP 200 from the rewrite endpoint:

- Parse response as JSON.
- Validate `result.data.text` is a string with `trim().length > 0`.
- If empty or missing, return `{ ok: false, error: { code: 'BRIDGE_EMPTY_RESPONSE', message: 'Rewrite returned an empty result.' } }`.
- Never apply an empty or whitespace-only string to the answer field.

**T2A response validation**

After a successful HTTP 200 from the T2A endpoint:

- Validate `content-type` is `audio/mpeg` (via `requestBinary`).
- Validate `ArrayBuffer.byteLength > 0`.
- If either check fails, return structured error; never attempt to create a local asset from an invalid blob.

**Auth**

- Both methods use `credentials: "include"`.
- Neither method sends `X-Bridge-Auth`, `X-Authenticated-Email`, or any other header that could be confused with a trusted bridge header. The reverse proxy injects those.

---

### 2. Protected intent payload — refactor `triggerProtectedAction`

The current editor `triggerProtectedAction(actionId)` always stores the same generic payload `{ localDraftId }`. This is insufficient. Refactor the signature to:

```js
async triggerProtectedAction(actionId, intentPayload = {})
```

The `intentPayload` is merged into the `pendingIntent` stored by `SharedAuthGate`. Required payloads by action:

| Action ID | Intent payload |
|---|---|
| `viewerRewrite` | `{ localAttemptId, blockId, answerTextAtClickTime }` |
| `editorPromptT2A` | `{ localDraftId, blockId, target: "question_prompt" }` |
| `editorOptionT2A` | `{ localDraftId, blockId, target: "option", optionId }` |

`answerTextAtClickTime` is the **exact trimmed text from the answer field at the moment the Rewrite button was clicked** before any sign-in redirect. This ensures post-login replay sends the same text that was visible to the learner, not whatever may be loaded on return.

---

### 3. `replayProtectedAction` — must dispatch, not stub

Both viewer and editor currently have `replayProtectedAction` that does nothing beyond storing `intent.actionId`. This must be replaced with a real dispatch:

**Viewer**

```
replayProtectedAction(intent):
  if intent.actionId === 'viewerRewrite':
    call rewriteText(intent.payload.answerTextAtClickTime)
    apply result to answer for intent.payload.blockId
    store pre-rewrite answer in undoBuffer[blockId]
    renderUI()
```

**Editor**

```
replayProtectedAction(intent):
  if intent.actionId === 'editorPromptT2A':
    call generateAudioFromText(promptText for intent.payload.blockId)
    attach result via attachQuestionMedia(blockId, 'question_audio', ...)
  if intent.actionId === 'editorOptionT2A':
    call generateAudioFromText(optionText for intent.payload.optionId)
    attach result via attachOptionAudio(blockId, optionId, ...)
```

---

### 4. Session state additions

**Viewer session state**

Add to viewer session state:

```js
undoBuffer: {},          // map of blockId -> string (pre-rewrite answer snapshot)
isRewriting: false,      // true while bridge call is in flight
rewritingBlockId: null,  // blockId of the block currently being rewritten
```

`undoBuffer` is stored on `session.state`, not as a local closure variable. This ensures undo state survives block navigation (the viewer re-renders on every block switch via `renderUI()`). The buffer is cleared for a given `blockId` when:

- the learner manually edits the answer for that block (any `input` event on the textarea), or
- a second rewrite on the same block succeeds.

**Editor session state**

Add to editor session state:

```js
isGeneratingAudio: null,  // null or { blockId, target, optionId? }
```

`isGeneratingAudio` is checked before accepting a new T2A request — if already set, the new request is dropped with feedback `"Audio generation is already in progress."`.

---

### 5. Viewer rewrite — full behavior spec

1. `Rewrite` button is rendered below the textarea, right-aligned, whenever visibility rules pass (see Button Placement).
2. On click (authenticated):
   a. Set `session.state.isRewriting = true`, `session.state.rewritingBlockId = blockId`.
   b. Snapshot current trimmed answer into `session.state.undoBuffer[blockId]`.
   c. Disable `Rewrite` button (show `"Rewriting…"`), disable `Undo`.
   d. Call `apiClient.rewriteText(trimmedAnswer)`.
   e. On success: apply `result.data.text` to answer field via the same path as a manual answer edit (so `maxLength` clamping and text-counter update fire as normal). Set `isRewriting = false`. Show `Undo` button. `renderUI()`.
   f. On failure: restore answer to snapshot (if it was modified), set `isRewriting = false`, show inline error (e.g. `"Rewrite failed. Your answer is unchanged."`). `renderUI()`.
3. On click (not authenticated):
   a. Snapshot `{ localAttemptId, blockId, answerTextAtClickTime: trimmedAnswer }` into intent payload.
   b. Call `authGate.runProtectedAction({ actionId: 'viewerRewrite', ... })`.
   c. Answer field is left unchanged. Sign-in redirect proceeds.
4. `Undo` button on click:
   a. Restore answer to `undoBuffer[blockId]`.
   b. Delete `undoBuffer[blockId]`.
   c. Hide `Undo`. `renderUI()`.
5. `renderUI()` must check `session.state.isRewriting` and render the loading state consistently. This prevents autosave-triggered re-renders from showing a non-loading button while a call is in flight.

---

### 6. Editor T2A — full behavior spec

1. `Generate audio` / `Regenerate audio` is rendered in the question audio row and MC option actions row whenever the source text is non-empty and within 200 chars.
2. On click, before any API call:
   a. If audio already exists for that target, show the **same replace confirmation dialog** used for manual upload replacements. If the teacher cancels, stop here — do not call the bridge.
   b. If confirmed (or no existing audio), proceed.
3. Set `session.state.isGeneratingAudio = { blockId, target, optionId }`.
4. Disable all audio row action buttons for that target.
5. Call `apiClient.generateAudioFromText(sourceText)`.
6. On success:
   a. Create a `File`-like object (Blob with name `generated_audio_<blockId>.mp3`, type `audio/mpeg`) from the returned `Uint8Array`.
   b. Route through `attachQuestionMedia(blockId, 'question_audio', file, { confirmReplace: false })` or `attachOptionAudio(blockId, optionId, file, { confirmReplace: false })`. The replace guard is already handled in step 2; passing `confirmReplace: false` skips the double-check.
   c. The generated asset may be tagged with `{ origin: 't2a' }` in local metadata for debugging. The exported package structure is unchanged.
   d. Set `isGeneratingAudio = null`. `updateSummary()`.
7. On failure:
   a. Leave existing audio untouched.
   b. Set `isGeneratingAudio = null`.
   c. Show error via `pushNotification` / editor activity feed: `"Audio generation failed. Existing audio is unchanged."` plus the error detail.
8. "Persisted non-empty option" in the context of T2A means: the option exists in the draft with a non-empty `label` or `value` string after trim. It does not require the option to already have an audio attachment. An empty placeholder option (before the teacher enters text) keeps the button disabled.

---

### 7. Data model and docs

- No popup launch-hash or popup `postMessage` schema changes are planned.
- `server/worksheet_launcher/widgets/rewrite-widget.js` remains untouched (per AGENTS.md restriction).
- No worksheet/package schema change is needed; generated MP3s reuse the existing asset model and `mediaRefs`.
- `docs/message-contract.md` stays unchanged unless implementation ends up modifying popup auth-callback or popup transport contracts.
- All user-visible strings must use plain language. Do not expose "T2A", "rewrite bridge", "OIDC", or any internal jargon in button labels, hints, or error messages.

---

## Implementation Stages

### Stage 1 — API Layer and Contract Foundation

**Goal**: all bridge API methods exist, are callable, return correct structured results, and are covered by unit tests. No UI changes yet. Existing stubs remain in place. This stage is done when the bridge calls work end-to-end in a real browser session and tests pass.

**Tasks**

1. Add `BRIDGE_API_BASE = '/api/rewrite-bridge'` constant to `server-api-client.js`. Confirm it is not derived from `options.apiBase` or query params.
2. Add `requestBinary(path, expectedMime, request)` private helper to `server-api-client.js`. Covers: auth error detection, content-type mismatch, zero-byte response, network error.
3. Add `rewriteText(text)` method to the client. Includes response validation (non-empty trimmed string in `data.text`).
4. Add `generateAudioFromText(text)` method to the client. Uses `requestBinary`.
5. Refactor `triggerProtectedAction(actionId, intentPayload)` in `editor/main.js` to accept and forward `intentPayload`. Update all existing callsites to pass `{}` so they are unaffected.
6. Implement real dispatch in `replayProtectedAction(intent)` in both `viewer/main.js` and `editor/main.js` for the new action IDs.
7. Add session state fields: `undoBuffer`, `isRewriting`, `rewritingBlockId` to viewer; `isGeneratingAudio` to editor.
8. Write or update unit tests for:
   - `rewriteText`: success, empty-response guard, auth error, network error.
   - `generateAudioFromText`: success, zero-byte guard, content-type mismatch, auth error.
   - `triggerProtectedAction` payload forwarding.

**Verification checkpoint for Stage 1**

- In a signed-in browser session, calling `apiClient.rewriteText("hello world")` from the browser console returns `{ ok: true, data: { text: "..." } }`.
- Calling `apiClient.generateAudioFromText("hello world")` returns `{ ok: true, data: Uint8Array }` and the bytes are a valid MP3.
- In a signed-out session, both methods return `{ ok: false, error: { code: 'AUTH_REQUIRED', requiresSignIn: true } }`.
- All new unit tests pass.

---

### Stage 2 — Viewer UI: Rewrite and Undo

**Goal**: the contextual `Rewrite` and `Undo` buttons appear and work correctly in the viewer. The utility-menu stub is removed.

**Tasks**

1. Remove `rewriteAssistBtn` from `utilityMenuList` in `viewer/main.js`.
2. Add the rewrite action row (right-aligned below the textarea) to the text question block render path in `renderUI()`.
3. Render rules: show `Rewrite` when visibility conditions pass; show `Undo` only if `undoBuffer[blockId]` exists; both hidden when `isRewriting === true` except `Rewrite` which shows `"Rewriting…"` disabled.
4. Wire `Rewrite` click: authenticated path and unauthenticated redirect path (with `answerTextAtClickTime` in intent).
5. Wire `Undo` click: restore from `undoBuffer`, delete entry, re-render.
6. Wire textarea `input` event: delete `undoBuffer[blockId]` to clear undo on manual edit.
7. Ensure `renderUI()` reads `session.state.isRewriting` and `session.state.rewritingBlockId` to show the loading label atomically, so autosave-triggered re-renders do not flash an active button during a call.

**Verification checkpoint for Stage 2**

- `Rewrite` appears only on `text` questions with non-empty answers that are within 300 chars and not completed.
- `Rewrite` is absent on `number`, `boolean`, `multiple_choice`, content blocks, and completed attempts.
- Clicking `Rewrite` while authenticated calls the bridge and updates the answer in-place with counters updated.
- `Undo` appears after a successful rewrite; clicking it restores the exact prior answer and hides itself.
- Manually editing the answer after a rewrite hides `Undo`.
- Clicking `Rewrite` while signed out opens the sign-in flow; after login, rewrite replays for the same block with the snapshotted text.
- Answer is unchanged if the API call fails.

---

### Stage 3 — Editor UI: T2A Generate Audio

**Goal**: `Generate audio` / `Regenerate audio` buttons appear in the correct rows and work correctly. The editor stubs are removed.

**Tasks**

1. Remove `rewriteBtn` and `t2aBtn` from `protectedActionsColumn` in `editor/main.js`.
2. Add `Generate audio` / `Regenerate audio` to the question audio row in the block detail panel. Place it right-aligned next to the existing `Attach audio…` / `Replace audio…` button.
3. Apply T2A visibility rule: disabled if `trim(promptText).length === 0` or `> 200`; show 200-char hint if over limit.
4. Wire click: replace confirmation (before bridge call) → set `isGeneratingAudio` → call `generateAudioFromText` → attach result via `attachQuestionMedia`.
5. Add `Generate audio` / `Regenerate audio` to each MC option actions row. Same disable rules applied to the option label.
6. Wire click for option T2A: same flow using `attachOptionAudio`.
7. During generation, disable all audio action buttons for that target row. Restore on completion or failure.
8. On failure, push notification to activity feed with plain-language message.

**Verification checkpoint for Stage 3**

- `Generate audio` appears in every question audio row when prompt text is non-empty and ≤ 200 chars.
- It is disabled with a hint when prompt text exceeds 200 chars.
- Clicking `Generate audio` when audio exists shows the replace confirmation first; cancelling does not call the bridge.
- On success, a playable MP3 is attached and the row updates to show `Regenerate audio`, `Play`, `Remove`.
- On failure, existing audio is unchanged and the activity feed shows an error.
- `Generate audio` is absent for MC options with empty label/value.
- Export → import round-trip for a package with generated audio works correctly (audio is in `mediaRefs` and plays in the viewer).

---

## Test Plan

### Viewer

- `Rewrite` shown only for `text` questions with non-empty (≤ 300 chars) answer, not completed.
- `Rewrite` hidden for `number`, `boolean`, `multiple_choice`, content blocks, completed attempts, empty answers, and answers over 300 chars.
- `Rewrite` button shows `"Rewriting…"` (disabled) while the call is in flight; `renderUI()` re-entry during that window does not reset the label.
- Successful rewrite applies `result.data.text` to the answer field; text counter and max-length clamping behave as on a manual edit.
- `Undo` appears only after a successful rewrite; it restores the exact pre-rewrite answer.
- Undo state persists across block navigation within the same session (stored on `session.state.undoBuffer`, not a closure variable).
- Manual edit after rewrite clears undo state for that block.
- Second rewrite on the same block clears prior undo and establishes a new undo snapshot.
- Bridge returns empty string → rewrite does not modify the answer; shows error.
- Bridge call fails → answer is unchanged; error is shown inline.
- Logged-out click → auth flow starts; post-login replay uses `answerTextAtClickTime` from the intent, not the live field.

### Editor

- `Generate audio` appears for question prompts with non-empty text ≤ 200 chars.
- `Generate audio` disabled (with hint) when prompt text > 200 chars.
- `Generate audio` disabled (no hint) when prompt text is empty.
- Clicking `Generate audio` when no existing audio skips the replace confirmation and calls the bridge directly.
- Clicking `Regenerate audio` when audio exists shows the replace confirmation before calling the bridge.
- Cancelling replace confirmation does not call the bridge and does not modify existing audio.
- During generation, all audio action buttons for that row are disabled.
- Concurrent generation on the same target is blocked (`isGeneratingAudio` guard).
- On success, MP3 is attached; row shows `Regenerate audio`, `Play`, `Remove`.
- On failure, existing audio is unchanged; activity feed shows error.
- MC option `Generate audio` is disabled for options with empty label/value.
- MC option T2A attaches as `option_audio`; existing audio replace confirm is required.
- Export/import/viewer playback of generated audio works without schema change.
- `rewriteBtn` and `t2aBtn` no longer exist in the DOM.

### API layer (unit tests)

- `rewriteText`: 200 success with valid text; 200 with empty `data.text` returns `BRIDGE_EMPTY_RESPONSE`; 401 returns `AUTH_REQUIRED`; network error returns `NETWORK_ERROR`.
- `generateAudioFromText`: 200 with valid MP3 bytes; 200 with zero bytes returns `BRIDGE_EMPTY_RESPONSE`; content-type mismatch returns `UNEXPECTED_CONTENT_TYPE`; 401 returns `AUTH_REQUIRED`.
- `triggerProtectedAction(actionId, intentPayload)` forwards `intentPayload` into `SharedAuthGate`.

---

## Assumptions and Defaults

- Public bridge routes are available same-origin under `/api/rewrite-bridge/*` and share the project's Google OIDC session.
- Browser clients never send `X-Bridge-Auth` or `X-Authenticated-Email`; the reverse proxy injects them.
- Rewrite uses non-stream mode only in this phase.
- T2A uses binary MP3 output only in this phase.
- The 300-char (rewrite) and 200-char (T2A) limits are client-side guards only; the bridge may have its own server-side limits which take precedence. Client limits are set conservatively below expected server limits.
- Generated local asset metadata may tag `origin: 't2a'` for debugging purposes. The exported package structure is unchanged — no new fields in the package ZIP schema.
- `docs/message-contract.md` is unchanged until a concrete need to modify popup transport arises during implementation.
