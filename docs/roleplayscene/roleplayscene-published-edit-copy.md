# Open a published RolePlayScene as an editable copy

> Current behavior reviewed against main `7bb19de` on 2026-10-06. Code evidence: [main.js](../../server/roleplayscene/scripts/main.js), [storage.js](../../server/roleplayscene/scripts/storage.js). Test commands below are guidance, not a new test-run report.

In Browse Published, choose **Open as editable copy**. The action downloads the
existing published ZIP using the same authenticated read endpoint as playback.
The button shows downloading status, a percentage when a valid total is known,
and preparation status. Duplicate opens and competing local import/new-story
actions are blocked while it runs.

After preparation, the existing replacement confirmation is shown. Cancel leaves
the current local story intact and releases the candidate media URLs. Confirm
replaces the current local story, just like importing a ZIP; export work you want
to retain before replacing it. Discussion-discard safeguards still apply.

The copy opens in Edit mode with a localized copy suffix on its title (the existing
copy-generation cap remains 120 UTF-16 code units). This inherited title is
preserved even when it exceeds the editor's new
[40-code-point limit for title edits](roleplayscene-story-titles.md).
Scene IDs, links, dialogue and packaged media are
preserved. RolePlayScene projects have no server publication identity to detach.
This operation never uploads, deletes or modifies the original publication.
Upload and publish remain separate, explicit actions with their existing name
conflict confirmations. A copy is not an additional slot in a local library:
RolePlayScene still uses its existing single local project snapshot.

When starting from a direct-link player, confirmation also reconnects local
autosave and removes the published launch query so reload opens the local copy.
Playback and ordinary uploaded-draft opening remain supported.

## Verification and rollback

- `npm test`
- With `node scripts/static-server.mjs` running:
  `node scripts/roleplayscene-edit-copy-smoke.mjs`
- Retain import/new-story, dialogue-order, discussion-voice and music-navigation
  smoke checks. New browser fixtures use isolated storage and synthetic API data,
  not production publications. They check both locales and 1280/390px widths.

This feature is merged on `main`. For future rollout rollback, use the deployment’s recorded validated revision rather than the historical PR parent.
No database migration is required by editable-copy opening. Live authentication,
large production packages, and physical mobile devices still require VPS QA.
