# RolePlayScene discussion voice input

This PR stacks on #275 (`codex/package-sign-in-style`). Keep the stack open for review and VPS acceptance. Do not merge or deploy automatically.

The discussion input, including choice cue-card discussions, offers **Add by voice / 用語音加入**. Sign-in is checked before microphone permission. A successful recording is transcribed, only the new transcript is rewritten, and the result is inserted at the end or after a deliberately placed caret/selection. Existing discussion text is preserved; Undo restores the exact previous text. Whole-discussion Rewrite stays explicit. Its input limit is now 2,000 Unicode code points, separate from total discussion length. No worksheet answer-length limit is imposed.

The discussion session adapts the existing worksheet recorder, processing workflow and recovery controls. It owns operations independently of panel DOM. One operation runs per story session. Closing a panel or navigating stops recording and processes the original scene; later network results never switch scenes or move focus away from another discussion. Changing stories or leaving player mode cancels the operation and advances a generation guard. Story fingerprint, generation, scene and text snapshots protect insertion.

Dialogue and automatic advancement stop before capture in both normal and speech-bubble playback. Background music is muted/stopped and its control reflects this. Playback does not resume automatically: use Play/Play All and the existing music Unmute control. Playback controls are unavailable while capture is active. Print is temporarily disabled during processing, with an explanation.

Only the target discussion is read-only. A compact View/Stop/Cancel status remains visible when the panel is closed. Another scene permits typing while voice/rewrite are unavailable. Cancel releases the lock immediately and rejects late results.

Recovery uses the existing sessionStorage lifetime. Transcript text is backed up before rewriting; empty recovery remains editable. Retry after transcription rewrites without uploading audio again. Unresolved recovery blocks new voice and whole-discussion rewriting for that scene until resolved/discarded. Preflight sign-in failure requires another explicit click. Upload authentication failures can retain audio in memory for explicit retry; audio is never stored. Recovery text is excluded from discussion printing and story packages. Saving failures show a warning in the discussion panel.

No backend routes, providers, environment settings, database migration, editor controls, package contracts, or frozen rewrite widget changes are required. The recorder retains its existing approximately one-minute and 20 MiB limits. Slow requests remain visibly pending until cancellation or transport failure; no automatic retries were introduced.

## Verification

- Run `npm test` for the full suite, including adapter tests for insertion, undo, preflight, cancellation/reused scene IDs, sessionStorage recovery, print exclusion, and Unicode limits.
- Start `node scripts/static-server.mjs`, then run `node scripts/roleplayscene-voice-smoke.mjs`. Optional `VIEWER_SMOKE_SCREENSHOTS` saves screenshots. This uses synthetic microphone/API data and the real player UI in both playback modes, both languages, desktop and mobile. It checks cue-card/ordinary entry, close/reopen, capture playback lock, cross-scene completion/focus, print lock, recovery editing and retry.
- `node scripts/viewer-completed-review-smoke.mjs` covers the existing worksheet voice/completed-review integration. The older `viewer-voice-smoke.mjs` currently has an ambiguous textarea selector introduced by the prior completed-review UI; it fails before exercising voice completion. This PR does not modify that unrelated script.

## VPS and device acceptance

Check out `codex/roleplayscene-discussion-voice` after fetching origin. No new configuration is required; existing transcription/rewrite routes and HTTPS microphone access must work. Test real recordings in Windows Chrome/Edge, actual iPad Safari and mobile Chrome. Verify dialogue/music stops before recording and requires explicit resume; deny permission; expire login during upload; throttle/disconnect; cancel/retry; close or change scenes during each stage; replace stories with reused scene IDs; reload transcript recovery; print; and test cue-card layouts in portrait/landscape. Automated synthetic recordings do not establish real provider/device compatibility. No live provider calls or VPS deployment are performed during automated verification.
