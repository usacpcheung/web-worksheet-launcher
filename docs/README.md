# Documentation index

Current references were reviewed against `main` commit `7bb19de276a6553ea4266e6158dae48f25a4cc6b` on 2026-10-06. They describe checked-in implementation, not proof of a live VPS deployment or a new product roadmap. Start new development from the latest `main` and recheck affected code when behavior changes.

## Where to find the authoritative reference

This index is the single entry point for maintained repository documentation. Current product, architecture, contract and operation references are centralized under `docs/` in the sections below. Use these references for current work; `past/` contains history and does not govern implementation. Each topic has one maintained reference: amend it when behavior changes instead of creating another competing specification. If a cross-cutting contract and a feature guide disagree, check the latest code and correct both references together.

Contributor instructions, discoverable UI skills, colocated module/font notes and legal attribution retain their required locations and are linked here. They supplement this index; they are not alternative product specifications. The review register records decisions and evidence, rather than defining another contract.

## Architecture and contracts

- [Runtime ownership and flows](architecture/runtime.md)
- [Local model and compatibility boundaries](contracts/local-models.md)
- [Worksheet, attempt and RolePlayScene packages](contracts/package-formats.md)
- [Implemented PostgreSQL schema](contracts/database-schema.md)
- [Authentication messages, response schema and viewer launch](message-contract.md)
- [Worksheet published browsing and slot handling](contracts/editor-viewer-backend-contract.md)
- [Retired widget boundary](contracts/widget-retirement.md)

## Worksheet editor and viewer

- [Replacement and package opening](worksheet/editor-worksheet-replacement.md)
- [Move commands and mouse dragging](worksheet/worksheet-block-reordering.md)
- [Limited Markdown, prompt limits and typography](worksheet/worksheet-limited-markdown.md)
- [Audio voice choices](worksheet/editor-voice-choice.md)
- [Learner voice, rewrite, recovery and Undo](worksheet/viewer-voice-workflow.md)
- [Published loading feedback](worksheet/viewer-package-load-progress.md)

## RolePlayScene

- [Publishing metadata and search](roleplayscene/roleplayscene-publishing-contract.md)
- [Direct-link loading](roleplayscene/roleplayscene-direct-link-loading.md)
- [Published editable copies](roleplayscene/roleplayscene-published-edit-copy.md)
- [Story titles](roleplayscene/roleplayscene-story-titles.md)
- [Scene names and stable IDs](roleplayscene/roleplayscene-scene-names.md)
- [Dialogue ordering](roleplayscene/roleplayscene-dialogue-order.md)
- [Remembered voice choices](roleplayscene/roleplayscene-voice-choices.md)
- [Discussion voice and music coordination](roleplayscene/roleplayscene-discussion-voice.md)
- [Current responsive layout and proposal gaps](roleplayscene/responsive-layout.md)

## Operations and contribution

- [Server configuration, routes and deployment boundary](operations/server-runtime.md)
- [Testing and fixture use](operations/testing.md)
- [Localization](operations/localization.md)
- [Artifact maintenance](operations/published-artifact-maintenance.md)
- [Test-data cleanup](operations/testing-data-cleanup.md)
- [Contributor rules](../AGENTS.md)
- [Worksheet UI guidance](../.agents/skills/worksheet-ui-design-language/SKILL.md)
- [RolePlayScene UI guidance](../.agents/skills/roleplayscene-editor-ui-design/SKILL.md)
- [Local compatibility modules](../server/app/contracts/README.md)
- [Font provenance and license](../server/app/fonts/README.md)
- [Local reference workspace](../reference/README.md)

## History and maintenance policy

[past/](past/README.md) contains superseded plans, retired widget instructions, early phase checkpoints and dated audits. Archive status concerns documentation authority; it never means an input format or product capability can be removed. Historical commands, branch names, test counts and acceptance criteria are evidence about their stated baseline only.

The [review register](reviews/documentation-review-2026-10-06.md) covers all 45 original Markdown files and both license texts. Keep current behavior in the folders above. Put completed or superseded planning records in `past/`, with a reason and a link to their replacement. Update current contracts alongside behavior changes, including shared consumers. Do not turn an unimplemented archived proposal into an active requirement without a new decision.
