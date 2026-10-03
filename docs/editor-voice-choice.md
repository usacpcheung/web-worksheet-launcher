# Worksheet editor audio voice choices

Worksheet prompt and multiple-choice-option audio generation use the bridge's
provider-independent `voice_choice` field. The editor retains its existing three
language actions; each action selects one complete narration preset.

| Editor language / saved preset ID | Request `voice_choice` |
| --- | --- |
| `cantonese` | `cantonese_narrator_female` |
| `mandarin` | `mandarin_narrator_female` |
| `english` | `english_narrator_female` |

The mappings live in `server/editor/t2a-language-presets.js`. The shared API client
sends authenticated, same-origin POST requests to `/api/rewrite-bridge/t2a`:

```json
{
  "text": "Hello, welcome",
  "voice_choice": "english_narrator_female",
  "format": "mp3",
  "response_mode": "binary"
}
```

The bridge owns voice identity, language, speed, volume, pitch and effects. A named
choice must not include `voice_id`, `language_boost`, `speed`, `volume` or `pitch`.
The client rejects explicit conflicting fields, including null, undefined and
empty values, with `INVALID_INPUT` before making a request. It also rejects
non-string and blank choices instead of dropping them and requesting default
speech. Choice strings are trimmed; the bridge validates their case-sensitive
IDs and provider support. Rejections are returned without retrying with defaults.

The bridge catalogue and provider mappings are defined by
[rewrite bridge PR #126](https://github.com/usacpcheung/hk-ollama-rewrite-bridge/pull/126).
The narrator choices correspond to the editor's previous voices under standard
tuning. Named choices fix speed/volume/pitch at `1/1/0` for Cantonese and Putonghua
and `0.85/1/0` for English. They do not inherit customized generic voice environment
defaults. Output settings, text budgets and timeouts remain configured by the bridge.

## Compatibility and scope

MP3 validation, replacement confirmation and generation locks remain in place.
Pressing a prompt or option Generate action stops the editor's current audio
preview, including pending preview loads, before confirmation. Cancelling or
failing generation preserves the saved track so it can be played again.
A rejected request leaves existing tracks and assets intact. Generation captures
the active worksheet ID and an opening generation counter; switching or reopening
worksheets invalidates pending results. After local asset storage finishes, the
editor rechecks the worksheet, target, source text and existing track before
attaching audio. Obsolete generated assets are removed without replacing old tracks.

Authentication failures received after a successful session probe retain their
structured error and enter the shared sign-in recovery flow. Recovery persists
the intent only while its original record remains active. The existing restore
flow validates the target before replay; a failed recovery replay clears the
pending intent and does not automatically redirect a second time.

Saved `audioTracks[].voicePresetId` remains the track's language ID (or null for
manually attached audio). The API choice ID is not stored in that field: existing
normalizers and package validators require the language ID. Existing packages,
import/export, assets and viewer playback need no migration or regeneration.

The shared client continues to accept legacy raw-control and no-options requests
when `voice_choice` is absent. RolePlayScene presets and no-language editor replay
paths keep their current requests. This change adds no character-voice selector,
provider/model switch, endpoint or authentication contract.

## Validation and release

Run `npm test` and the affected local browser checks:

```text
node scripts/editor-voice-choice-smoke.mjs
node scripts/editor-option-audio-smoke.mjs
node scripts/worksheet-markdown-smoke.mjs
node scripts/roleplayscene-project-title-smoke.mjs
node scripts/viewer-voice-smoke.mjs
node scripts/roleplayscene-voice-smoke.mjs
```

Use `scripts/static-server.mjs` on loopback. The browser checks use isolated contexts
and mocked APIs. The voice-choice smoke exercises six actual editor/client requests,
replacement cancellation, bridge rejection, a stale response, ZIP export/import,
real playback of synthetic silent MP3s in the viewer and all existing RolePlayScene
raw presets in English/Traditional Chinese at desktop/mobile widths. These checks
do not synthesize speech or access production records.

The deployed bridge must support the named-choice contract before editor rollout.
An older bridge can ignore the unknown field and generate default Cantonese audio.
Before deployment, verify a real named-choice request for each language against the
VPS and listen to the output. Successful raw-control calls alone do not establish
named-choice support. This code PR does not merge, deploy or change VPS configuration.
