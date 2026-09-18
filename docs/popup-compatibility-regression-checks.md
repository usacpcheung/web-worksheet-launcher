# Popup compatibility regression checks

> **Widget retirement (Step 2):** The popup-specific checklist below is historical and no longer an acceptance gate. Use the retirement boundary tests and retained-product regression checks instead.
> See [scope, retained services and deployment gates](widget-removal-step2.md).

Use this checklist when reviewing popup-launcher-related changes to ensure the v1 compatibility slice remains stable.

- [ ] Parent app can still launch popup successfully.
- [ ] Rewrite widget still initializes in popup.
- [ ] Response returns to parent with expected `type` / `rid` / `origin` / `source` checks enforced.
- [ ] One-question / one-answer mapping invariant still holds.
- [ ] No unapproved behavior drift in `server/worksheet_launcher/render.js`.
- [ ] If changed, docs include compatibility justification + contract diff + versioning note.
