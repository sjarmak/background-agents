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
TOTAL=$(echo "$REPORT" | jq -r '.summary.total')
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

RESULT_COUNT=$(echo "$REPORT" | jq '.results | length')
for i in $(seq 0 $((RESULT_COUNT - 1))); do
  STATUS=$(echo "$REPORT" | jq -r ".results[$i].status")
  ID=$(echo "$REPORT" | jq -r ".results[$i].id")
  SEVERITY=$(echo "$REPORT" | jq -r ".results[$i].severity")
  VIOLATION_COUNT=$(echo "$REPORT" | jq ".results[$i].violations | length")

  case "$STATUS" in
    pass) ICON=":white_check_mark:" ;;
    fail) ICON=":x:" ;;
    *)    ICON=":warning:" ;;
  esac

  COMMENT+="| \`$ID\` | $SEVERITY | $ICON $STATUS | $VIOLATION_COUNT |\n"
done

# Add violation details if any
if [[ "$FAILED" -gt 0 ]]; then
  COMMENT+="\n### Violations\n\n"

  for i in $(seq 0 $((RESULT_COUNT - 1))); do
    STATUS=$(echo "$REPORT" | jq -r ".results[$i].status")
    [[ "$STATUS" != "fail" ]] && continue

    ID=$(echo "$REPORT" | jq -r ".results[$i].id")
    MESSAGE=$(echo "$REPORT" | jq -r ".results[$i].message")
    COMMENT+="#### \`$ID\`\n"
    COMMENT+="> $MESSAGE\n\n"

    VIOLATION_COUNT=$(echo "$REPORT" | jq ".results[$i].violations | length")
    LIMIT=$((VIOLATION_COUNT < 10 ? VIOLATION_COUNT : 10))

    for j in $(seq 0 $((LIMIT - 1))); do
      REPO_NAME=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].repo")
      FILE=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].file")
      LINE=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].line")
      DETAIL=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].detail")
      COMMENT+="- \`$REPO_NAME\` — [\`$FILE:$LINE\`](https://github.com/$REPO_NAME/blob/main/$FILE#L$LINE) — $DETAIL\n"
    done

    if [[ "$VIOLATION_COUNT" -gt 10 ]]; then
      COMMENT+="\n_...and $((VIOLATION_COUNT - 10)) more violations_\n"
    fi
    COMMENT+="\n"
  done
fi

COMMENT+="\n---\n_Checked by Cross-Repo Invariant Verifier_"

if [[ "$FORMAT_ONLY" == "true" ]]; then
  # Output formatted markdown to stdout
  echo -e "$COMMENT"
else
  # Post comment using gh CLI
  echo -e "$COMMENT" | gh pr comment "$PR_NUMBER" --repo "$REPO" --body-file -
  echo "Posted comment to $REPO#$PR_NUMBER" >&2
fi
