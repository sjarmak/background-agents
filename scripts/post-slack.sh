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

if ! command -v jq &>/dev/null; then
  echo "Error: 'jq' is required but not found in PATH" >&2
  exit 1
fi

if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
  echo "Error: SLACK_WEBHOOK_URL must be set" >&2
  exit 1
fi

# Read report from stdin
REPORT=$(cat)

if ! echo "$REPORT" | jq empty 2>/dev/null; then
  echo "Error: report on stdin is not valid JSON" >&2
  exit 1
fi

# Parse summary
TOTAL=$(echo "$REPORT" | jq -r '.summary.total')
FAILED=$(echo "$REPORT" | jq -r '.summary.failed')
ERRORS=$(echo "$REPORT" | jq -r '.summary.errors')
TIMESTAMP=$(echo "$REPORT" | jq -r '.timestamp')

# Build header
if [[ "$FAILED" -eq 0 && "$ERRORS" -eq 0 ]]; then
  HEADER=":white_check_mark: All $TOTAL cross-repo invariants pass"
else
  HEADER=":x: $FAILED violations found ($ERRORS errors) out of $TOTAL invariants"
fi

# Canary is a synthetic probe that MUST fail — a fired canary proves the pipeline works,
# so color reflects non-canary failures/errors only
CANARY_FIRED=$(echo "$REPORT" | jq '[.results[] | select(.id | startswith("canary-")) | select(.status == "fail" and (.violations | length) >= 1)] | length')
NON_CANARY_BAD=$(echo "$REPORT" | jq '[.results[] | select(.id | startswith("canary-") | not) | select(.status != "pass")] | length')

if [[ "$CANARY_FIRED" -ge 1 ]]; then
  CANARY_LINE="Pipeline health: OK (canary fired)"
  if [[ "$NON_CANARY_BAD" -eq 0 ]]; then
    COLOR="good"
  else
    COLOR="danger"
  fi
else
  CANARY_LINE=":rotating_light: PIPELINE BROKEN: canary did not fire — results untrustworthy"
  COLOR="danger"
fi

# Build violation detail lines
DETAIL_LINES=()
RESULT_COUNT=$(echo "$REPORT" | jq '.results | length')
for i in $(seq 0 $((RESULT_COUNT - 1))); do
  STATUS=$(echo "$REPORT" | jq -r ".results[$i].status")
  ID=$(echo "$REPORT" | jq -r ".results[$i].id")
  SEVERITY=$(echo "$REPORT" | jq -r ".results[$i].severity")
  DESC=$(echo "$REPORT" | jq -r ".results[$i].description")

  if [[ "$STATUS" == "pass" ]]; then
    DETAIL_LINES+=(":white_check_mark: *${ID}* (${SEVERITY}) — ${DESC}")
  elif [[ "$STATUS" == "fail" ]]; then
    MESSAGE=$(echo "$REPORT" | jq -r ".results[$i].message")
    VIOLATION_COUNT=$(echo "$REPORT" | jq ".results[$i].violations | length")
    DETAIL_LINES+=(":x: *${ID}* (${SEVERITY}) — ${VIOLATION_COUNT} violation(s)")

    # List up to 5 violations
    LIMIT=$((VIOLATION_COUNT < 5 ? VIOLATION_COUNT : 5))
    for j in $(seq 0 $((LIMIT - 1))); do
      REPO=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].repo")
      FILE=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].file")
      LINE=$(echo "$REPORT" | jq -r ".results[$i].violations[$j].line")
      DETAIL_LINES+=("    • \`${REPO}\` — \`${FILE}:${LINE}\`")
    done
    if [[ "$VIOLATION_COUNT" -gt 5 ]]; then
      DETAIL_LINES+=("    • _...and $((VIOLATION_COUNT - 5)) more_")
    fi
    DETAIL_LINES+=("    _${MESSAGE}_")
  else
    DETAIL_LINES+=(":warning: *${ID}* (${SEVERITY}) — error during check")
  fi
done

# Assemble details, capped so the Slack text block stays under ~2900 chars
MAX_DETAILS_CHARS=2900
BUDGET=$((MAX_DETAILS_CHARS - 80))
DETAILS=""
DROPPED=0
for DETAIL_LINE in "${DETAIL_LINES[@]}"; do
  if [[ "$DROPPED" -gt 0 || $((${#DETAILS} + ${#DETAIL_LINE} + 1)) -gt "$BUDGET" ]]; then
    DROPPED=$((DROPPED + 1))
  else
    DETAILS+="${DETAIL_LINE}"$'\n'
  fi
done
if [[ "$DROPPED" -gt 0 ]]; then
  DETAILS+="_…and $DROPPED more — see the run artifact_"$'\n'
fi

# Build Slack payload
PAYLOAD=$(jq -n \
  --arg color "$COLOR" \
  --arg header "$HEADER" \
  --arg details "$DETAILS" \
  --arg canary "$CANARY_LINE" \
  --arg timestamp "$TIMESTAMP" \
  --arg channel "${SLACK_CHANNEL:-}" \
  '{
    attachments: [{
      color: $color,
      blocks: [
        {type: "header", text: {type: "plain_text", text: $header}},
        {type: "section", text: {type: "mrkdwn", text: $details}},
        {type: "context", elements: [{type: "mrkdwn", text: $canary}]},
        {type: "context", elements: [{type: "mrkdwn", text: ("Invariant check ran at " + $timestamp)}]}
      ]
    }]
  } + (if $channel != "" then {channel: $channel} else {} end)')

post_payload() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "$SLACK_WEBHOOK_URL"
}

# Post to Slack, with one retry on rate-limit or server error
HTTP_CODE=$(post_payload) || HTTP_CODE="000"
if [[ "$HTTP_CODE" == "429" || "$HTTP_CODE" =~ ^5[0-9][0-9]$ ]]; then
  echo "Warning: Slack webhook returned HTTP $HTTP_CODE — retrying once" >&2
  sleep 2
  HTTP_CODE=$(post_payload) || HTTP_CODE="000"
fi

if [[ "$HTTP_CODE" -ne 200 ]]; then
  echo "Error: Slack webhook returned HTTP $HTTP_CODE" >&2
  exit 1
fi

echo "Posted to Slack (HTTP $HTTP_CODE)" >&2
