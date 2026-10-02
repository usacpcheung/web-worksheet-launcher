# RolePlayScene Cantonese voice choices

## PR scope and base

This feature is stacked on PR #300 (`codex/editor-t2a-voice-choice`), verified
at commit `7c2ebc67a128f3265a940303af621aa2a66a2af8`. It changes RolePlayScene
authoring and optional package metadata, not the bridge or player behavior.

The editor offers Narrator / 旁白, Male 1–3 / 男聲 1–3 and Female 1–3 / 女聲 1–3.
They send `cantonese_narrator_female`, `cantonese_male_1` through `_3`, and
`cantonese_female_1` through `_3` respectively. Only `voice_choice` is sent for
voice selection. The bridge owns provider tuning. The narrator replaces the old
server-dependent default with an explicit choice.

## Selection behavior

- An explicit line choice takes precedence over a speaker's remembered choice.
- An unset line uses an identifiable attached voice, then its speaker's remembered
  choice, then Narrator. Merely rendering a suggestion does not save a choice or
  update a speaker preference.
- Explicitly choosing a voice saves it on the line and updates that speaker's
  remembered choice. Generation captures its selected choice on the line but does
  not overwrite the speaker's preference merely because it used a suggestion.
- Existing explicit selections and recordings do not change when a speaker
  preference changes. Speakers are optional; voices may be shared.
- Speaker identity uses `speaker.id`, so renaming retains the preference.
  Assigning a different speaker does not erase a line selection.
- Generation stops dialogue preview before confirmation. Cancellation and errors
  leave existing media intact. Line identity and source text are rechecked after
  asynchronous work; changed attachments still require replacement confirmation.
- Session expiry displays a persistent message on the affected line, with Sign in.
  After signing in, press Generate again. There is no automatic generation replay.

## Optional version-1 package fields

These fields are retained by model normalization, IndexedDB snapshots,
`content/project.json`, ZIP export/import and published package reuse:

| Location | Field | Meaning |
| --- | --- | --- |
| `speakers[]` | `lastVoiceChoice` | Last voice explicitly chosen on a line assigned to this speaker |
| `scenes[].dialogue[]` | `voiceChoice` | Voice selected for this line's next generation |
| `scenes[].dialogue[].audio` | `generatedVoiceChoice` | Voice used to create this attached audio; null for a new custom upload |

Choice values are stable identifiers, never translated labels. Unknown strings
remain visible as an invalid selection and cannot generate until corrected.
No package version bump or media regeneration is required. Older application
versions can still play the audio but may drop optional authoring fields on resave.

When `generatedVoiceChoice` is absent, old `-t2a-...mp3` filename suffixes remain
a best-effort compatibility fallback. The five previous suffixes are preserved;
their recognised voices initialize a legacy line selection without assigning any
speaker preference. Explicit null suppresses filename inference for new uploads.
Other recordings display Custom voice / 自訂聲音. The attached voice badge is
separate from the next-generation selector; a known difference shows a regenerate
notice. A label change alone never alters a recording.

## Boundaries

No batch generation, permanent speaker inheritance, automatic regeneration,
provider controls, Mandarin/English expansion, player redesign, auth callback
contract change, database migration, merge or VPS deployment is included.
Existing discussion, music, publishing, worksheets and legacy raw API calls remain
supported. Do not use live production records in automated validation.

## Verification

Run `npm test`, `git diff --check`, and these browser scripts against the local
static server:

- `scripts/roleplayscene-voice-choice-smoke.mjs`
- `scripts/editor-voice-choice-smoke.mjs`
- `scripts/roleplayscene-dialogue-order-smoke.mjs`
- `scripts/roleplayscene-voice-smoke.mjs`
- `scripts/roleplayscene-music-navigation-smoke.mjs`
- `scripts/editor-option-audio-smoke.mjs`

Coverage must include seven requests, saved choices, later scenes, reorder,
package round trips, custom and legacy audio, invalid choices, duplicate calls,
source changes, identical-line deletion/project replacement, expiry and manual
retry, keyboard focus, English/Traditional Chinese, and desktop/mobile widths.
The full-app voice smoke uses synthetic MP3s and mocked APIs. Before release,
verify all seven choices against the deployed bridge and listen to the real
output; automated tests do not establish provider availability or voice quality.

## Review hardening

Session probes have a 15-second deadline and generation waits have a two-minute deadline. Timeout aborts
the active request, releases the line lock and asks for manual retry.
Changing the target or closing the editor cancels the obsolete request and ignores
its late result or error. Cancellation does not guarantee the remote provider has
not processed a request, so there are no automatic retries.

Removing a previously confirmed attachment during generation cancels attachment
of the late replacement. New playback URLs are allocated before the old URL is
revoked, so allocation failures preserve the existing recording. Binary transport
read failures are returned as structured errors by the shared client.

Review tests exercise 401/403, HTML sign-in responses, unsupported choices, server
errors, offline fetches, empty audio, interrupted response bodies, stalled session
checks/generation, disposal, manual retries, and line/project replacement while
requests remain pending.

Local autosave waits for IndexedDB transaction completion and reports transaction
aborts as save failures. Pending edits flush on visibility loss, page exit and
persistence cleanup. The browser warns before leaving while a save is pending or
has failed; once committed, ordinary navigation needs no autosave warning.
Server Save reserves its lock before session preflight and retains one serialized
project snapshot, including metadata, through replace/copy and slot-limit retries.
Regression coverage includes `scripts/roleplayscene-autosave-smoke.mjs` and
`server/roleplayscene/tests/upload-race.test.mjs`.

Sign-in flows own bounded, cancellable session probes, so retrying after a stalled
probe starts a fresh request. ZIP downloads preserve HTTP 502/503 as server errors
instead of requesting sign-in. Draft-list responses apply only while their request
and modal revision remain current; stale responses cannot release a newer lock.
JSON and ZIP imports reject malformed dialogue text before replacing the project.
Existing string, missing and null dialogue text remains supported; restored local
snapshots normalize text to strings defensively.
