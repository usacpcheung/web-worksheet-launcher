# Current package formats

Reviewed against main `7bb19de` on 2026-10-06. Code authorities: `server/editor/worksheet-package.js`, `audio-tracks.js`, `zip-utils.js`; viewer attempt builders/parsers in `server/viewer/main.js`; API package validation; RolePlayScene `scripts/storage.js` and `server/api/services/roleplayscene-package.js`.

## Supported envelopes

| Content | Manifest `format` | Current export version / schema | Accepted compatibility |
| --- | --- | --- | --- |
| Plain worksheet with audio tracks | `worksheet-package` | 2 / 2 | Worksheet versions 1, 2 and 3 are read; legacy JSON remains a separate import adapter. |
| Worksheet containing limited Markdown | `worksheet-package` | 3 / 3 | Markdown in version 1/2 envelopes is rejected. |
| Plain worksheet attempt | `worksheet-attempt-package` | 1 / 1 | Attempt version 1 and 2 are read. |
| Attempt containing limited Markdown | `worksheet-attempt-package` | 2 / 1 | Markdown in version 1 attempt envelopes is rejected. |
| RolePlayScene | `roleplayscene-package` | 1 | Browser imports also accept plain project JSON and legacy root `project.json` ZIPs; server draft upload requires the current package envelope. |

Worksheet/attempt ZIP helpers support stored (uncompressed) entries and validate entry sizes, CRCs and duplicate names. RolePlayScene uses bundled `fflate` archive reading and has separate API decompression resource limits; do not generalize its compression support to worksheet ZIP import.

## Worksheet ZIP

```text
manifest.json
content/worksheet.json
media/*
```

Manifest export includes `format`, `packageVersion`, `schemaVersion`, `generatedAt`, `worksheet` local identity/title/timestamps, `provenance` and `assets`. Content holds title, blocks and metadata. Manifest assets identify `assetId`, media-relative path, kind/usage, MIME type, byte length and CRC32. Content references logical asset IDs, not absolute filesystem URLs.

Question images use `prompt.mediaRefs`. Version-1 prompt/option audio references remain readable. Current prompt and multiple-choice option `audioTracks` contain `language`, `assetId`, `voicePresetId` and `sourceTextHash`. Languages are `cantonese`, `mandarin`, `english`, with at most one track per language. `voicePresetId` is the language ID or null, not the API `voice_choice`. Mixed legacy audio references and multilingual tracks are rejected rather than exported ambiguously.

Editor ZIP import keeps an imported source record, stores binary media locally and creates a separate editable draft. It does not overwrite an existing draft by package ID. Compatible JSON requires nonempty blocks and uses the legacy adapter. Editor opening/replacement and old-audio migration confirmations remain supported. See [replacement](../worksheet/editor-worksheet-replacement.md).

Missing/`plain_text` text formats remain literal; `limited-markdown-v1` enables the documented subset; unknown formats fail validation. Editable plain-text conversion escapes source to preserve display. See [Markdown and version rules](../worksheet/worksheet-limited-markdown.md).

## Attempt ZIP

```text
manifest.json
content/worksheet.json
content/attempt.json
media/*
```

The embedded worksheet includes title/subject/owner, blocks, and compatibility IDs in metadata. Attempt content has schema version 1, `kind: worksheet-attempt`, timestamps, answers, optional checking data and status `in_progress`, `submitted` or `checked`. Manifest `attempt.localAttemptId` is local provenance, not the server `uploaded_attempt_id`.

Resume restores from embedded content, never from a newer external worksheet. Restore creates new local identities and supports answer/check review without requiring the old local records. Recovery transcripts and raw recorded audio are excluded; packaged worksheet media remains included. Explicit upload uses the private `/attempts/upload` API with owner slots and conflict recovery, not automatic sync.

## RolePlayScene ZIP

```text
manifest.json
content/project.json
media/*
```

The version-1 serializer includes project metadata, speakers, scenes and packaged media references. Scene flow uses exact unique IDs; scene names are presentation metadata. Optional `speakers[].lastVoiceChoice`, dialogue `voiceChoice`, and audio `generatedVoiceChoice` survive current saves/package round trips without a version bump. Older app builds may drop optional authoring fields when resaving.

Browser import prepares and validates before replacement confirmation; apply is separate. Incomplete drafts can be repaired in the editor. Server publish validates a complete playable graph and required media, rather than treating upload warnings as publish permission. Legacy browser import support does not mean arbitrary legacy ZIPs can be uploaded directly to the API.

See [scene identity/names](../roleplayscene/roleplayscene-scene-names.md), [voices](../roleplayscene/roleplayscene-voice-choices.md), [published metadata](../roleplayscene/roleplayscene-publishing-contract.md) and [server resource limits](../operations/server-runtime.md).

## Publication metadata and immutability

API upload/publish requests send ZIP bytes or an uploaded-draft UUID. Listing title/subject/description overrides do not rewrite embedded ZIP content. Artifacts receive separate server SHA-256 and size metadata; that hash is distinct from per-entry CRCs and viewer content fingerprints. New publication IDs do not mutate existing artifacts. Deleting a source draft preserves its publication; reopening a publication for authoring creates a local editable copy.
