# RolePlayScene scene names and stable identity

Scene names are editable presentation metadata. `scene.id` remains the immutable
reference used by choices (`nextSceneId`), automatic transitions
(`autoNextSceneId`), editor selection, media associations, playback history and
discussion answers/recovery. Changing a name must never rewrite those values.

## Package and local snapshot contract

Every scene written by the current browser serializer contains a string `name`:

```json
{
  "id": "scene01",
  "name": "Ordering drinks",
  "type": "start",
  "choices": [{ "id": "choice1", "label": "Continue", "nextSceneId": "ending" }]
}
```

This is an additive extension of `roleplayscene-package`, `packageVersion: 1`.
The ZIP layout (`manifest.json`, `content/project.json`, `media/`) is unchanged.
Old names/IDs are not shortened, case-folded, trimmed or renumbered on loading.
Missing, blank or non-string names fall back to the exact scene ID. New scenes
also start with their generated ID as the name. Duplicate names are allowed;
identity and flow are always resolved by exact ID, never by name.

Readers continue to accept plain project JSON, legacy root `project.json` ZIPs,
current packages, local IndexedDB snapshots, uploaded drafts and published
packages. All subsequent browser saves and exports write `name` for every scene,
even when the source did not contain it. This covers local autosave, server draft
upload and the artifact later used for publishing. Existing long names/IDs remain
intact. No database, published artifact or deployment migration is required.

Playing an existing publication does not rewrite it. Opening a published package
as an editable copy and saving/exporting that copy writes the current structure.
Publishing a previously uploaded artifact without opening and saving it retains
that artifact, as before. Older application versions can still follow IDs but
may discard the new name property when they save; use the updated editor to
retain names.

Names are excluded from the existing discussion/playback recovery fingerprint.
A name-only edit therefore does not invalidate scene-associated answers or
recovery. Player history retains its dialogue-first label and uses the scene
name as its fallback. Discussion print titles show name and ID for disambiguation.

## Authoring and long labels

The right-hand editor panel (below the map on narrow screens) has a labeled
**Scene name / 場景名稱** field at the top of Scene basics, followed by the read-only
**Scene ID / 場景 ID**. Both wrap to show the complete value and offer Copy actions.
Clipboard-unavailable browsers select the field for manual copying instead.

Names update map/destination labels as the author types; Chinese IME composition
is committed only after composition ends. Newly edited names allow 80 Unicode
code points. An unchanged inherited longer name remains valid and is never
silently clipped. An over-limit edit stays visible with a “Not saved” error;
the last valid value remains in the project and in saves/exports. Clearing the
field falls back to its ID when the edit is committed. The name draft remains
editable until blur, so users can select-all and type a replacement normally.

The SVG map fits text to the actual available width, accounting for the image
thumbnail, and appends an ellipsis without changing stored data. Hover or
keyboard focus reveals the full name and ID; Escape dismisses the tooltip.
Selecting a card exposes the complete values in the editor, including on touch.
Destination controls store IDs, show `name · id`, and have a wrapping description
of their current target. All imported names are rendered as text, never HTML.

## Import integrity and compatibility

Browser JSON/ZIP imports and server package upload share scene identity rules:
IDs must be nonempty strings and unique under exact, case-sensitive comparison.
Do not impose the generated `scene-001` spelling, ASCII-only rules or a new
length cap on legacy IDs. `intro`, ` intro ` and `INTRO` remain distinct keys.
Numeric suffix parsing uses safe integers, and generated IDs skip existing IDs,
including after the sequence wraps past the maximum safe integer.

Identity checks run before model defaults or media URL allocation can hide a
missing ID. Invalid imports identify the scene index, fail before replacement
confirmation and leave the current project intact. Server upload uses
`INVALID_ROLEPLAYSCENE_PROJECT`; Publish retains
`INVALID_ROLEPLAYSCENE_PUBLISH_PACKAGE` for identity failures. No automatic
renumbering attempts to guess the meaning of ambiguous duplicate IDs.

Incomplete drafts (for example, an unassigned destination) can still be imported
and repaired in the editor. Existing Play/Publish graph validation remains the
completion gate. Local snapshot restoration retains its existing compatibility
behavior. Malformed old source artifacts are not overwritten: correct their
reported IDs/references in a separate copy and re-import it. This feature does
not introduce a bulk repair or rewrite of existing publications.

## Verification

- `npm test`: model/storage round trips, legacy formats/media, shared identity
  validation, safe ID generation, recovery and print associations.
- `node scripts/roleplayscene-scene-name-smoke.mjs`: isolated English/Traditional
  Chinese Chromium contexts at 1280px and 390px; real editor input/IME, duplicate
  labels, long names/IDs, keyboard/hover/copy, flow preservation, autosave/reload,
  old local/server draft loading, exported and uploaded packages, rejected-import
  preservation. The edit-copy smoke also asserts the name written for an old
  published package.
- Retained RolePlayScene edit-copy, confirmation, dialogue-order, voice and
  music-navigation smoke scripts cover the adjacent consumers separately.

Browser tests use local fixtures and mocked API/media services. They do not
certify live VPS authentication, provider calls, screen readers, physical mobile
devices or Safari/Firefox behavior.

## Deployment

Deploy the frontend and API changes together and restart the API process to load
the shared upload identity validator. No dependency installation, database
migration or republishing of existing content is required for this feature.
