# RolePlayScene story titles

> Current behavior reviewed against main `7bb19de` on 2026-10-06. Code evidence: [project-title.js](../../server/roleplayscene/scripts/project-title.js), [project-title-control.js](../../server/roleplayscene/scripts/editor/project-title-control.js), [ui.js](../../server/roleplayscene/scripts/player/ui.js). Test commands below are guidance, not a new test-run report.

The editor's **Project title** field edits `project.meta.title`, displayed at
the top of the story start screen. New edits allow up to 40 Unicode code points
(`Array.from(title).length`). Chinese characters and supplementary characters
such as ordinary emoji count as one; combining marks and joined emoji sequences
can contain multiple code points. Empty titles retain the existing player fallback.

The field shows a count and an inline error for an over-limit edit. Invalid or
unfinished IME input stays in a transient editor draft. Autosave, export and
server upload use the last valid title, as stated by the error message. The draft
survives scene selection and preview, but is cleared when loading or creating
another project. It is not persisted across page reloads.

Existing titles longer than 40 code points remain supported in local files,
browser drafts, server drafts and published packages. Loading, playing, saving
or exporting them does not truncate or reject them. Their unchanged displayed
value is accepted; changing to another title requires the new limit. Native undo
within the field can restore its original inherited title, including original
line endings that the single-line input cannot display.

This is an authoring limit, not a package validator or API limit. Package version,
storage shape, scene names/IDs, and published listing title overrides are
unchanged. Published edit-copy titles are treated as inherited titles, including
any generated copy suffix. See [publishing metadata](roleplayscene-publishing-contract.md).

The start screen wraps full titles and allows scrolling inside the frame when
content cannot fit. Start remains reachable with wheel, touch and keyboard;
short titles retain the centered Start layout and upper-left Utilities control.
