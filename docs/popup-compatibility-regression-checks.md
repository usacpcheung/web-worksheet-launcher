# Popup compatibility regression checks

Use this checklist when reviewing popup-launcher-related changes to ensure the v1 compatibility slice remains stable.

- [ ] Parent app can still launch popup successfully.
- [ ] Rewrite widget still initializes in popup.
- [ ] Response returns to parent with expected `type` / `rid` / `origin` / `source` checks enforced.
- [ ] One-question / one-answer mapping invariant still holds.
- [ ] No unapproved behavior drift in `server/worksheet_launcher/render.js`.
- [ ] If changed, docs include compatibility justification + contract diff + versioning note.
