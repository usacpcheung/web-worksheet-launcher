# Local reference directory

Use this folder for ignored, local-only comparison material such as API exports, experiment drafts and vendor snippets. `.gitignore` ignores its contents except the README and optional scaffold. None of those ignored files were reviewed as repository documentation.

Treat local material as reference input, not source of truth. Keep supported contracts in [docs/](../docs/README.md), current runtime in the tracked product/shared modules, and final changes in reviewed commits. Do not add secrets or private credentials here.

Suggested prompt: “Compare the current worksheet or RolePlayScene implementation with a local reference file, preserving the active contracts and existing content compatibility.” The old rewrite-widget comparison example is obsolete because that widget and parent SDK are retired.
