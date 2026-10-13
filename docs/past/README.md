# Historical documentation

These records are preserved for traceability. They are not current setup instructions, supported API specifications, merge gates or an approved future roadmap. Reviewed against main `7bb19de` on 2026-10-06. Original decisions and reported results remain historical; archive notices explain why each moved.

Use the [current documentation index](../README.md) and [complete review register](../reviews/documentation-review-2026-10-06.md) for active behavior and evidence. Archiving a document does not retire package compatibility or product features. Shared login/voice/API services remain covered by the [active retirement boundary](../contracts/widget-retirement.md).

## Phase 1 contracts and model proposals

- [adr-phase1-worksheet-model.md](phase1/adr-phase1-worksheet-model.md)
- [message-contract.md](phase1/message-contract.md)
- [phase1-blueprint-index.md](phase1/phase1-blueprint-index.md)
- [phase1-route-versioning.md](phase1/phase1-route-versioning.md)

## Superseded plans and early implementation checkpoints

- [local-package-format-phase-a.md](plans/local-package-format-phase-a.md)
- [phase-d-server-foundation.md](plans/phase-d-server-foundation.md)
- [roleplayscene-responsive-layout-spec.md](plans/roleplayscene-responsive-layout-spec.md)
- [temp-plan-viewer-rewrite-editor-t2a-not-final.md](plans/temp-plan-viewer-rewrite-editor-t2a-not-final.md)
- [worksheet-architecture-redesign-plan.md](plans/worksheet-architecture-redesign-plan.md)
- [worksheet_launcher_db_schema.md](plans/worksheet_launcher_db_schema.md)
- [worksheet_launcher_editor_viewer_spec.md](plans/worksheet_launcher_editor_viewer_spec.md)

## Retired widget and completed retirement records

- [README_rewrite_widget.md](widget/README_rewrite_widget.md)
- [parent-launcher-sdk.md](widget/parent-launcher-sdk.md)
- [popup-compatibility-regression-checks.md](widget/popup-compatibility-regression-checks.md)
- [render-security-headers.md](widget/render-security-headers.md)
- [task-parent-launcher-cleanup.md](widget/task-parent-launcher-cleanup.md)
- [widget-removal-step1.md](widget/widget-removal-step1.md)
- [widget-removal-step2.md](widget/widget-removal-step2.md)

## Dated audits and validation reports

- [cleanup-audit-main-v1.md](audits/cleanup-audit-main-v1.md)
- [i18n-audit.md](audits/i18n-audit.md)
- [viewer-editor-compat-validation.md](audits/viewer-editor-compat-validation.md)

## Reading historical records

The original message contract mixed still-active response/auth sections with a retired parent protocol. Its full historical copy stays here while the stable `docs/message-contract.md` path now covers only current contracts. The old ADR’s snapshot utilities still exist in client compatibility modules; the current local-model guide distinguishes that from unimplemented server proposals.

Old branch names, PR stacks, deletion candidates, rollback commits and test counts describe their original baselines. In particular, the responsive proposal is only partly realized and cache-first publication loading is not implemented. Remaining ideas are not silently promoted to required work. Old renderer security-header examples must not be applied wholesale to products that support microphone capture or shared login.
