# Current package formats

Reviewed against main `7bb19de` on 2026-10-06. Code authorities: `server/editor/worksheet-package.js`, `audio-tracks.js`, `zip-utils.js`; viewer attempt builders/parsers in `server/viewer/main.js`; API package validation; RolePlayScene `scripts/storage.js` and `server/api/services/roleplayscene-package.js`.

## Supported envelopes

| Content | Manifest `format` | Current export version / schema | Accepted compatibility |
| --- | --- | --- | --- |
| Plain worksheet with audio tracks | `worksheet-package` | 2 / 2 | Worksheet versions 1–6 are read; legacy JSON remains a separate import adapter. |
| Worksheet containing limited Markdown | `worksheet-package` | 3 / 3 | Markdown in version 1/2 envelopes is rejected. |
| Plain worksheet attempt | `worksheet-attempt-package` | 1 / 1 | Attempt versions 1–5 are read. |
| Attempt containing limited Markdown | `worksheet-attempt-package` | 2 / 1 | Markdown in version 1 attempt envelopes is rejected. |
| Worksheet containing option images | `worksheet-package` | 4 / 4 | Also supports limited Markdown; older readers reject this envelope. |
| Attempt containing option images | `worksheet-attempt-package` | 3 / 1 | Also supports limited Markdown; older readers reject this envelope. |
| Worksheet containing image responses | `worksheet-package` | 5 / 5 | Also supports Markdown and option images. |
| Attempt containing image responses | `worksheet-attempt-package` | 4 / 1 | Includes answer images. |
| Worksheet containing long text | `worksheet-package` | 6 / 6 | Also supports image responses, Markdown and option images; older readers reject it. |
| Attempt containing long text | `worksheet-attempt-package` | 5 / 1 | Includes all earlier features; older readers reject it. |
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


## Image-package integrity and local import ownership

Worksheet v4 and attempt v3 validate asset manifests before import: media-relative
paths, unique asset IDs and paths, nonempty files, optional byte-length/CRC32
metadata, and option-image MIME/size limits. Invalid manifests are rejected before
local or server persistence. Existing legacy envelope readers retain their
compatibility policy; no new package version or database migration is introduced.

Attempt export/upload requires every referenced question/option image and audio
asset to exist and contain bytes. Preparation fails without downloading a partial
ZIP or sending an upload when required media is missing. Local answers are kept;
English/Traditional Chinese messages distinguish missing local media from a
network failure. Newly built attempt packages pass validation before leaving the
builder.

Viewer local-file and server imports allocate fresh local asset IDs and remap
worksheet references. Editor imports do the same for the editable draft and the
saved imported-worksheet record. Import rollback only removes staged records and
new assets, including a write that completes before reporting failure; it must
not overwrite or remove media owned by existing drafts/attempts. Editor cancelled
imports discard staged records before exposing an incoming draft.

## Optional attempt presentation metadata

`content/attempt.json.metadata` may contain `studentName` (string),
`studentNameResolved` (boolean), `attemptName` (string), and optional
`attemptNameMode` (`auto` or `custom`). Automatic names follow the worksheet title
and current student name; custom names remain independent. Missing fields retain
legacy defaults. `studentNameResolved: true` records an explicit decision to
continue without a name as well as a confirmed name; print and server save share
that decision. The existing details panel remains editable. These optional fields
do not change package versions or the embedded worksheet title.

Local ZIP import creates a new local attempt and uses `attemptName` only as an
editable suggestion. It never imports server ownership, IDs, or replacement
permission. Server resume uses the authenticated list row's name and subject,
including a generated copy suffix, in preference to the embedded suggestion.
The immutable ZIP in a server copy may still contain the original suggestion.

## Image-response questions and answer media

Worksheets containing `responseConfig.inputType: "image_response"` use worksheet
package/schema version **5**. At most three image-response questions are allowed;
each has integer `maxImages` from 1 to 3 and no automatic correct-answer key.
Worksheet v5 retains Markdown, MC option images and multilingual audio. Older
worksheets keep their previous envelopes; current readers still accept v1–v4.

Such attempts use package version **4**, manifest/attempt schema version 1, and
ordered answers `answers[blockId].value: [{ assetId }]`. Empty arrays mean unanswered.
Every reference must be unique within its answer, within the question's count limit,
and backed by packaged JPEG/PNG bytes at most 2 MiB, with valid bounded headers and
matching MIME. Answer media accompanies embedded worksheet media in `media/*`.
The new envelope always requires the standard attempt schema/status; the historical
browser envelope defaults remain limited to attempt v1–v3. All readers and server
uploads share these checks. An exported v4 ZIP is checked against 30 MiB exactly.

Editor package preparation and import check the maximum full-attempt budget:
worksheet media plus allowed image-answer capacity, text-answer capacity, content
and package allowance. Publication uses that validated worksheet package. Export
captures worksheet/answers before asynchronous media reads and temporarily blocks
image replacement; missing bytes fail export. Existing prepared upload bytes and
slot/conflict retry rules remain unchanged. Import allocates new IDs and remaps
both worksheet references and answer references, preserving order and isolation.
See [image-response behavior and limits](../worksheet/image-response-investigation.md).


## Long text responses

Text questions may set `responseConfig.textMode` to `standard` or `long`.
New standard questions default to `maxLength: 200`, with an authoring ceiling of
1,200. Long text defaults to 20,000, requires multiline display, and supports a
configured integer limit from 1 to 20,000. Missing `textMode` remains legacy text;
existing packages are readable without rewriting their configuration or answers.
An editor opening a legacy limit above 1,200 requires the author to enable Long
text or explicitly reduce the limit before exporting/publishing.

Long text requires worksheet package/schema **6/6** and attempt package/schema
**5/1**. The newest envelope wins when mixed with Markdown, option images or
image-response questions. Attempt v5 keeps v4's strict envelope and media checks.
It does not raise the server's 30 MiB upload limit; image-answer budget estimates
already include each text question's configured capacity.

Answers remain plain strings in `answers[blockId].value`. Editing checks the
resulting string, including selected-text replacement, in UTF-16 code units
(the established answer counter convention). Oversized edits are rejected whole,
not cut to fit. Already saved/imported oversized answers remain complete through
local recovery, resume, export, server upload and printing; shortening them in
stages is allowed. Long text never invokes voice/rewrite. The shared rewrite
provider input ceiling remains 2,000 Unicode code points for eligible questions.
