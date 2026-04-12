#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Cleanup test data from PostgreSQL and storage files.

Usage:
  scripts/cleanup-test-data.sh [options]

Options:
  --apply                 Execute deletes and file removals (default is dry-run).
  --owner-prefix PREFIX   Match owner_sub that starts with PREFIX (default: test-).
  --older-than-days DAYS  Only match rows older than DAYS (default: 7).
  --database-url URL      PostgreSQL connection string (default: DATABASE_URL env).
  --storage-root PATH     Root storage directory (default: STORAGE_ROOT env).
  -h, --help              Show this help message.

Examples:
  scripts/cleanup-test-data.sh
  scripts/cleanup-test-data.sh --apply --owner-prefix qa- --older-than-days 3
USAGE
}

APPLY=0
OWNER_PREFIX="test-"
OLDER_THAN_DAYS=7
DATABASE_URL="${DATABASE_URL:-}"
STORAGE_ROOT="${STORAGE_ROOT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    --owner-prefix)
      OWNER_PREFIX="${2:-}"
      shift 2
      ;;
    --older-than-days)
      OLDER_THAN_DAYS="${2:-}"
      shift 2
      ;;
    --database-url)
      DATABASE_URL="${2:-}"
      shift 2
      ;;
    --storage-root)
      STORAGE_ROOT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$DATABASE_URL" || -z "$STORAGE_ROOT" ]]; then
  RESOLVED_DATABASE_URL="$DATABASE_URL"
  RESOLVED_STORAGE_ROOT="$STORAGE_ROOT"
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  fi
  DATABASE_URL="${RESOLVED_DATABASE_URL:-${DATABASE_URL:-}}"
  STORAGE_ROOT="${RESOLVED_STORAGE_ROOT:-${STORAGE_ROOT:-}}"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required (flag --database-url or env var)." >&2
  exit 1
fi
if [[ -z "${STORAGE_ROOT:-}" ]]; then
  echo "STORAGE_ROOT is required (flag --storage-root or env var)." >&2
  exit 1
fi

if ! [[ "$OLDER_THAN_DAYS" =~ ^[0-9]+$ ]]; then
  echo "--older-than-days must be a non-negative integer." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required but was not found in PATH." >&2
  exit 1
fi

if [[ ! -d "$STORAGE_ROOT" ]]; then
  echo "Storage root does not exist: $STORAGE_ROOT" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
PATHS_FILE="$WORK_DIR/artifact_paths.txt"
FAILED_FILE_DELETES="$WORK_DIR/failed_file_deletes.txt"
OWNER_PREFIX_SQL=$(printf "%s" "$OWNER_PREFIX" | sed "s/'/''/g")

SQL_PATHS=$(cat <<SQL
WITH target_uploaded AS (
  SELECT artifact_path
  FROM uploaded_drafts
  WHERE owner_sub LIKE '${OWNER_PREFIX_SQL}%'
    AND created_at < now() - ('${OLDER_THAN_DAYS} days')::interval
), target_published AS (
  SELECT artifact_path
  FROM published_packages
  WHERE owner_sub LIKE '${OWNER_PREFIX_SQL}%'
    AND published_at < now() - ('${OLDER_THAN_DAYS} days')::interval
)
SELECT DISTINCT artifact_path
FROM (
  SELECT artifact_path FROM target_uploaded
  UNION ALL
  SELECT artifact_path FROM target_published
) all_paths
WHERE artifact_path IS NOT NULL
ORDER BY artifact_path;
SQL
)

SQL_COUNTS=$(cat <<SQL
SELECT 'uploaded_drafts' AS table_name, count(*) AS row_count
FROM uploaded_drafts
WHERE owner_sub LIKE '${OWNER_PREFIX_SQL}%'
  AND created_at < now() - ('${OLDER_THAN_DAYS} days')::interval
UNION ALL
SELECT 'published_packages' AS table_name, count(*) AS row_count
FROM published_packages
WHERE owner_sub LIKE '${OWNER_PREFIX_SQL}%'
  AND published_at < now() - ('${OLDER_THAN_DAYS} days')::interval
ORDER BY table_name;
SQL
)

echo "== Target filter =="
echo "owner_sub LIKE '${OWNER_PREFIX}%'"
echo "older than ${OLDER_THAN_DAYS} day(s)"
echo "storage_root: ${STORAGE_ROOT}"
echo

echo "== Candidate row counts =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -F $'\t' -c "$SQL_COUNTS" \
  | awk -F $'\t' '{ printf("%-20s %s\n", $1":", $2) }'

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "$SQL_PATHS" > "$PATHS_FILE"
ARTIFACT_COUNT=$(wc -l < "$PATHS_FILE" | tr -d ' ')
echo "artifact paths found: ${ARTIFACT_COUNT}"

if [[ "$APPLY" -eq 0 ]]; then
  echo
  echo "Dry-run only. No database rows or files were deleted."
  echo "Use --apply to perform cleanup."
  exit 0
fi

SQL_DELETE=$(cat <<SQL
BEGIN;
DELETE FROM published_packages
WHERE owner_sub LIKE '${OWNER_PREFIX_SQL}%'
  AND published_at < now() - ('${OLDER_THAN_DAYS} days')::interval;

DELETE FROM uploaded_drafts
WHERE owner_sub LIKE '${OWNER_PREFIX_SQL}%'
  AND created_at < now() - ('${OLDER_THAN_DAYS} days')::interval;
COMMIT;
SQL
)

echo
echo "== Deleting database rows =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$SQL_DELETE"

echo
echo "== Removing storage files =="
while IFS= read -r relpath; do
  [[ -z "$relpath" ]] && continue

  target="$STORAGE_ROOT/$relpath"
  normalized_target=$(realpath -m "$target")
  normalized_root=$(realpath -m "$STORAGE_ROOT")

  if [[ "$normalized_target" != "$normalized_root"/* ]]; then
    echo "skip (path escapes storage root): $relpath"
    continue
  fi

  if [[ -e "$normalized_target" ]]; then
    if rm -f "$normalized_target"; then
      echo "deleted: $relpath"
    else
      echo "$normalized_target" >> "$FAILED_FILE_DELETES"
      echo "failed to delete (permission?): $relpath"
    fi
  else
    echo "missing (already gone): $relpath"
  fi
done < "$PATHS_FILE"

if [[ -s "$FAILED_FILE_DELETES" ]]; then
  echo
  echo "Some files could not be removed due to permissions:"
  cat "$FAILED_FILE_DELETES"
  cat <<'TIPS'

Fix options on Linux server:
1) Check file ownership and mode:
   ls -l <path>
2) Make current service user the owner (example user: appsvc):
   sudo chown appsvc:appsvc <path>
3) Or grant write permission to owner/group:
   sudo chmod u+w <path>
   sudo chmod g+w <path>
4) Re-run this script with --apply.
TIPS
  exit 2
fi

echo
echo "Cleanup complete."
