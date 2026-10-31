# Current package formats

Reviewed against main `7bb19de` on 2026-10-06. Code authorities: `server/editor/worksheet-package.js`, `audio-tracks.js`, `zip-utils.js`; viewer attempt builders/parsers in `server/viewer/main.js`; API package validation; RolePlayScene `scripts/storage.js` and `server/api/services/roleplayscene-package.js`.

## Supported envelopes

| Content | Manifest `format` | Current export version / schema | Accepted compatibility |
| --- | --- | --- | --- |
| Plain worksheet with audio tracks | `worksheet-package` | 2 / 2 | Worksheet versions 1, 2, 3 and 4 are read; legacy JSON remains a separate import adapter. |
| Worksheet containing limited Markdown | `worksheet-package` | 3 / 3 | Markdown in version 1/2 envelopes is rejected. |
| Plain worksheet attempt | `worksheet-attempt-package` | 1 / 1 | Attempt versions 1, 2 and 3 are read. |
| Attempt containing limited Markdown | `worksheet-attempt-package` | 2 / 1 | Markdown in version 1 attempt envelopes is rejected. |
| Worksheet containing option images | `worksheet-package` | 4 / 4 | Also supports limited Markdown; older readers reject this envelope. |
| Attempt containing option images | `worksheet-attempt-package` | 3 / 1 | Also supports limited Markdown; older readers reject this envelope. |
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

The API and both attempt readers share the package/worksheet boundary in `server/app/contracts/attempt-package-validator.js`: the embedded worksheet must contain at least one block, with supported text formats and the appropriate Markdown package version. Empty worksheets are rejected before a ZIP is stored or a server slot is consumed. Uploads retain their strict attempt envelope, status, answers-object and checking-ID requirements. Browser imports retain historical envelope defaults and answer coercion, including numeric strings; their downstream viewer validation still applies. Legacy IDs/block kinds and optional missing media retain their existing compatibility paths. This shared boundary is not a replacement for the full viewer payload validator.

Editor export snapshots the draft, including its asset references, before asynchronous media reads. Editor uploads capture that snapshot before session preflight; viewer uploads capture listing metadata before asynchronous package media reads. Upload listing metadata stays with its package, so opening or editing another draft cannot mix its content with the original operation.

### Worksheet subject preservation

Current editor packages store the subject in `content/worksheet.json` under `metadata.subject`. For imported editable worksheets, the viewer uses the first nonblank value from `worksheet.subject`, `worksheet.metadata.subject`, the legacy import record's `subject`, then that record's `metadata.subject`. Explicit top-level subjects retain precedence for compatibility. Missing subjects remain empty. This subject propagates into the local attempt, exported attempt worksheet/manifest and server-upload listing metadata; reopening an imported worksheet uses the same precedence. No package version changes are required. This prevents future loss but cannot reconstruct metadata already erased from an older attempt.

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

API upload/publish requests send ZIP bytes or an uploaded-draft UUID. Publish-time listing title/subject/description overrides do not rewrite embedded ZIP content. Ordinary upload metadata can also differ from embedded content, but draft conflict-copy recovery is an exception: a generated copy title is rewritten into the newly stored worksheet or RolePlayScene ZIP. Attempt conflict-copy recovery changes its listing title without rewriting the ZIP. These operations leave the conflicting original artifact intact. Artifacts receive separate server SHA-256 and size metadata; that hash is distinct from per-entry CRCs and viewer content fingerprints. New publication IDs do not mutate existing artifacts. Deleting a source draft preserves its publication; reopening a publication for authoring creates a local editable copy.

## Multiple-choice option images

An option may contain text, one image, or both. Audio alone is insufficient. Images use
`options[].mediaRefs: [{ usage: "option_image", assetId }]`, backed by a manifest image
asset with usage `option_image`. Supported files are PNG, JPEG and WebP, up to 8 MB.
Optional `imageDescription` is plain alternative text limited to 200 Unicode code points;
it is not a visible caption or an audio-generation source. Empty `label` explicitly means
image-only. Stable nonempty `value` identifies the answer; captions must not replace that
identity when editing an image option. Correct answers, shuffle and attempt answers use
that same value.

The editor preserves incomplete local drafts but requires text or an image for every
option before packaging. Replacement clears the old image description. Removing an image
preserves the option's text and audio; an empty result requires repair. Package assets
survive publication, editor import, attempt export/resume and printing. Existing packages
without option images keep their previous envelope versions.

When any option has an image, the viewer uses two columns on desktop and one on mobile,
with equal cards and 96px contained image areas. Clicking the card/image selects an answer;
the separate magnifier opens an accessible modal without changing the answer. Audio remains
a separate control. Completed-review enlargement and printed images are supported.

Deploy the updated API parser together with editor/viewer assets and restart the API.
No database migration is required. RolePlayScene package formats are unchanged.

Editor preview uses the existing same-tab whole-worksheet viewer. There is no MC-only question preview dialog.
