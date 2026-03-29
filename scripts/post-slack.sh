#!/usr/bin/env bash
# post-slack.sh — Takes an invariant report on stdin, posts to Slack webhook.
#
# Usage:
#   ./scripts/verify-invariants.sh | ./scripts/post-slack.sh
#
# Environment:
#   SLACK_WEBHOOK_URL — Slack incoming webhook URL (required)
#   SLACK_CHANNEL     — Override channel (optional)

set -euo pipefail

if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
  echo "Error: SLACK_WEBHOOK_URL must be set" >&2
  exit 1
fi

# Read report from stdin
REPORT=$(cat)

# Parse summary
TOTAL=$(echo "$REPORT" | jq -r '.summary.total')
PASSED=$(echo "$REPORT" | jq -r '.summary.passed')
FAILED=$(echo "$REPORT" | jq -r '.summary.failed')
ERRORS=$(echo "$REPORT" | jq -r '.summary.errors')
TIMESTAMP=$(echo "$REPORT" | jq -r '.timestamp')

# Build header
if [[ "$FAILED" -eq 0 && "$ERRORS" -eq 0 ]]; then
  HEADER=":white_check_mark: All $TOTAL cross-repo invariants pass"
  COLOR="good"
else
  HEADER=":x: $FAILED violations found ($ERRORS errors) out of $TOTAL invariants"
  COLOR="danger"
fi

# Build violation details
DETAILS=""
RESULT_COUNT=$(echo "$REPORT" | jq '.results | length')
for i in $(seq 0 $((RESULT_COUNT - 1))); do
  STATUS=$(echo "$REPORT" | jq -r ".results[$i].status")
  ID=$(echo "$REPORT" | jq -r ".results[$i].id")
  SEVERITY=$(echo "$REPORT" | jq -r ".results[$i].severity")
  DESC=$(echo "$REPORT" | jq -r ".results[$i].description")

  if [[ "$STATUS" == "pass" ]]; then
    DETAILS+=":white_check_mark: *${ID}* (${SEVERITY}) — ${DESC}\n"
  elif [[ "$STATUS" == "fail" ]]; then
    MESSAGE=$(echo "$REPORT" | jq -r ".results[$i].message")
    VIOLATION_COUNT=$(echo "$REPORT" | jq ".results[$i].violations | length")
    DETAILS+=":x: *${ID}* (${SEVERITY}) — ${VIOLATION_COUNT} violation(s)\n"

    # List up to 5 violations
    LIMIT=$((VIOLATION_COUNT < 5 ? VIOLATION_COUNT : 5))
    for j in $(seq 0 $((LIMIT - 1))); do
      REPO=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].repo")
      FILE=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].file")
      LINE=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].line")
      DETAILS+="    • \`${REPO}\` — \`${FILE}:${LINE}\`\n"
    done
    if [[ "$VIOLATION_COUNT" -gt 5 ]]; then
      DETAILS+="    • _...and $((VIOLATION_COUNT - 5)) more_\n"
    fi
    DETAILS+="    _${MESSAGE}_\n"
  else
    DETAILS+=":warning: *${ID}* (${SEVERITY}) — error during check\n"
  fi
done

# Build Slack payload
PAYLOAD=$(jq -n \
  --arg color "$COLOR" \
  --arg header "$HEADER" \
  --arg details "$DETAILS" \
  --arg timestamp "$TIMESTAMP" \
  --arg channel "${SLACK_CHANNEL:-}" \
  '{
    attachments: [{
      color: $color,
      blocks: [
        {type: "header", text: {type: "plain_text", text: $header}},
        {type: "section", text: {type: "mrkdwn", text: $details}},
        {type: "context", elements: [{type: "mrkdwn", text: ("Invariant check ran at " + $timestamp)}]}
      ]
    }]
  } + (if $channel != "" then {channel: $channel} else {} end)')

# Post to Slack
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$SLACK_WEBHOOK_URL")

if [[ "$HTTP_CODE" -ne 200 ]]; then
  echo "Error: Slack webhook returned HTTP $HTTP_CODE" >&2
  exit 1
fi

echo "Posted to Slack (HTTP $HTTP_CODE)" >&2
