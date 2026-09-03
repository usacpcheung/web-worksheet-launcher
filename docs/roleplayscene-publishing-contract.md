# RolePlayScene publishing metadata and search

The public API prefix is `/api/worksheet-launcher/v1`; the backend route prefix
is `/api/v1`. These endpoints are separate from worksheet publishing.

## Publish an uploaded draft

`POST /roleplayscene/published` accepts JSON:

```json
{
  "uploadedDraftId": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Restaurant practice",
  "description": "Practice ordering food and asking for the bill."
}
```

- `description` is optional. A supplied string is trimmed and saved as the
  published listing description. An empty or whitespace-only string explicitly
  clears it, including when the source package contains a description.
- Omitting `description` preserves the previous behavior: use the uploaded
  draft description, then the package metadata description, then an empty string.
- The publish dialog requires a title and offers an optional multiline description,
  initially populated from the uploaded draft. Both entries survive title-conflict
  retries. Canceling the dialog does not publish or save these entries.
- These are published listing metadata. The source draft and ZIP artifact remain
  unchanged, as in the existing title override flow.
- Existing ownership checks, title-conflict handling, and publish-state rules apply.

Only one publishing flow can run at a time in the current page. All draft Publish
buttons are disabled from opening the publish dialog through title-conflict and
rename retries. Canceling before submission or during conflict recovery releases
the guard. Closing the manager after submission does not cancel the request or
release the guard early. Success and failures release it when processing ends.
Delayed responses only refresh or replace the manager that initiated the request;
they do not reopen a closed manager or replace another dialog. This frontend guard
supplements the existing backend transaction and title-uniqueness protection.

## Browse published packages

`GET /roleplayscene/published?q=restaurant&owner=teacher` combines filters with AND:

- `q`: case-insensitive substring search of title OR description only.
- `owner`: case-insensitive substring filter on owner name OR email.
- Existing `title`, `description`, `limit`, and `offset` parameters remain supported.

The browser labels these controls “Search title or description” and “Filter by
owner name or email”. Owner information no longer matches `q`; callers searching
for an owner must use `owner`.

Published descriptions continue to appear below package titles. Existing packages
with no description remain browsable and searchable by title and owner filter.
No database migration or republishing is required.
