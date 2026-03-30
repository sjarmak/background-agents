#!/usr/bin/env bash
# post-github-comment.sh — Takes an invariant report on stdin, posts as PR comment.
#
# Usage:
#   ./scripts/verify-invariants.sh | ./scripts/post-github-comment.sh owner/repo 123
#   ./scripts/verify-invariants.sh | ./scripts/post-github-comment.sh --format-only owner/repo 123
#
# Arguments:
#   --format-only (optional) — Output formatted markdown to stdout instead of posting
#   $1 — Repository (owner/repo format)
#   $2 — PR number
#
# Environment:
#   GH_TOKEN or GITHUB_TOKEN — GitHub auth (gh CLI uses these automatically)

set -euo pipefail

FORMAT_ONLY=false
if [[ "${1:-}" == "--format-only" ]]; then
  FORMAT_ONLY=true
  shift
fi

REPO="${1:?Usage: $0 [--format-only] OWNER/REPO PR_NUMBER}"
PR_NUMBER="${2:?Usage: $0 [--format-only] OWNER/REPO PR_NUMBER}"

if [[ "$FORMAT_ONLY" == "false" ]] && ! command -v gh &>/dev/null; then
  echo "Error: 'gh' CLI is required" >&2
  exit 1
fi

# Read report from stdin
REPORT=$(cat)

# Parse summary
TOTAL=$(echo "$REPORT" | jq -r '.summary.total') || { echo "Error: failed to parse report JSON" >&2; exit 1; }
PASSED=$(echo "$REPORT" | jq -r '.summary.passed')
FAILED=$(echo "$REPORT" | jq -r '.summary.failed')
ERRORS=$(echo "$REPORT" | jq -r '.summary.errors')

# Build markdown comment
COMMENT=""

if [[ "$FAILED" -eq 0 && "$ERRORS" -eq 0 ]]; then
  COMMENT+="## :white_check_mark: Cross-Repo Invariant Check — All $TOTAL passed\n\n"
else
  COMMENT+="## :x: Cross-Repo Invariant Check — $FAILED violation(s) found\n\n"
fi

COMMENT+="| Invariant | Severity | Status | Violations |\n"
COMMENT+="|-----------|----------|--------|------------|\n"

# Build table rows in one jq call
while IFS=$'\t' read -r ID SEVERITY STATUS VIOLATION_COUNT; do
  case "$STATUS" in
    pass) ICON=":white_check_mark:" ;;
    fail) ICON=":x:" ;;
    *)    ICON=":warning:" ;;
  esac
  COMMENT+="| \`$ID\` | $SEVERITY | $ICON $STATUS | $VIOLATION_COUNT |\n"
done < <(echo "$REPORT" | jq -r '.results[] | [.id, .severity, .status, (.violations | length | tostring)] | @tsv')

# Add violation details if any
if [[ "$FAILED" -gt 0 ]]; then
  COMMENT+="\n### Violations\n\n"

  # Extract all violation details in one jq call
  CURRENT_ID=""
  OVERFLOW=""
  while IFS=$'\t' read -r ID MESSAGE REPO_NAME FILE LINE DETAIL VCOUNT VINDEX; do
    if [[ "$ID" != "$CURRENT_ID" ]]; then
      # Close previous section overflow notice
      if [[ -n "$CURRENT_ID" && -n "$OVERFLOW" ]]; then
        COMMENT+="\n_...and $OVERFLOW more violations_\n"
      fi
      CURRENT_ID="$ID"
      OVERFLOW=""
      COMMENT+="#### \`$ID\`\n"
      COMMENT+="> $MESSAGE\n\n"
    fi
    # Validate LINE is numeric; sanitize fields to prevent markdown injection
    [[ "$LINE" =~ ^[0-9]+$ ]] || LINE="0"
    # Escape backslashes first (before other substitutions), then markdown-breaking chars
    DETAIL="${DETAIL//\\/\\\\}"
    DETAIL="${DETAIL//\`/\\\`}"
    DETAIL="${DETAIL//]/\\]}"
    DETAIL="${DETAIL//)/\\)}"
    FILE="${FILE//]/\\]}"
    FILE="${FILE//)/\\)}"
    REPO_NAME="${REPO_NAME//]/\\]}"
    REPO_NAME="${REPO_NAME//)/\\)}"
    COMMENT+="- \`$REPO_NAME\` — [\`$FILE:$LINE\`](https://github.com/$REPO_NAME/blob/main/$FILE#L$LINE) — $DETAIL\n"
    # Track overflow for this result
    if [[ "$VINDEX" == "9" && "$VCOUNT" -gt 10 ]]; then
      OVERFLOW="$((VCOUNT - 10))"
    fi
  done < <(echo "$REPORT" | jq -r '
    .results[] | select(.status == "fail") |
    .id as $id | .message as $msg | (.violations | length) as $vc |
    .violations[:10] | to_entries[] |
    [$id, $msg, .value.repo, .value.file, (.value.line | tostring), .value.detail, ($vc | tostring), (.key | tostring)] | @tsv')
  # Final overflow notice
  if [[ -n "$CURRENT_ID" && -n "$OVERFLOW" ]]; then
    COMMENT+="\n_...and $OVERFLOW more violations_\n"
  fi
  COMMENT+="\n"
fi

COMMENT+="\n---\n_Checked by Cross-Repo Invariant Verifier_"

if [[ "$FORMAT_ONLY" == "true" ]]; then
  # Output formatted markdown to stdout
  printf '%b' "$COMMENT"
else
  # Post comment using gh CLI
  printf '%b' "$COMMENT" | gh pr comment "$PR_NUMBER" --repo "$REPO" --body-file -
  echo "Posted comment to $REPO#$PR_NUMBER" >&2
fi
