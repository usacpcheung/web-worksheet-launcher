# RolePlayScene direct-link loading

RolePlayScene direct play URLs use the existing query parameter:

```text
/server/roleplayscene/index.html?publishedSceneId=<uuid>
```

The page enters a blocking launch state before its first asynchronous operation.
The normal toolbar and editor are hidden and inert while the client checks the
session, loads metadata, downloads the ZIP, and prepares the project. The player
is activated only after the complete package passes import validation.
Malformed published IDs are rejected in the browser before an API path is built;
the server continues to enforce its existing UUID validation as well.

The launch states are `checking-session`, `authentication-required`,
`authentication-pending`, `loading-metadata`, `downloading`, `preparing`, and
`error`. Download progress is determinate when the artifact response contains a
valid `Content-Length`; otherwise it remains indeterminate.

Authentication resumes the same scene after the existing popup flow succeeds.
Recoverable errors offer Retry. Missing or invalid links offer Browse Published.
All terminal states offer Return to editor. Retry creates a new attempt identity,
and callbacks from stale attempts cannot update the current launch state.

Return to editor and Exit published scene remove `publishedSceneId` and reload
the normal editor URL. Reloading is required because direct-link startup skips
local persistence initialization. Published scenes opened from the in-editor
browser retain their existing in-memory return behavior.

Browse Published from a direct-link error reloads with the temporary
`browsePublished=1` query parameter. Normal startup removes that parameter with
`history.replaceState` before opening the existing published browser.

## Interface compatibility

No HTTP endpoint, request schema, response schema, database table, or package
format changes. The browser API client accepts optional `{ signal, onProgress }`
options for published metadata and artifact requests. Existing one-argument
callers remain valid.
