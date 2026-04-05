#!/usr/bin/env bash
# e2e-verify.sh — End-to-end test for the cross-repo invariant verifier.
#
# Tests the TypeScript path (src/index.ts via tsx) against a live Sourcegraph
# instance, then validates:
#   1. Report JSON structure and consistency
#   2. Canary invariant fires (pipeline integrity)
#   3. Real invariants produce meaningful results
#   4. PR comment formatting (--format-only dry run)
#   5. Slack payload formatting (local HTTP sink)
#   6. Negative tests (missing env vars)
#
# Usage:
#   ./tests/e2e-verify.sh           # TS path (default)
#   ./tests/e2e-verify.sh --shell   # Shell script path (requires claude -p auth)
#
# Prerequisites:
#   - .env.local with SOURCEGRAPH_ACCESS_TOKEN and SOURCEGRAPH_URL
#   - node, npx, jq, python3 in PATH
#   - For --shell mode: claude, yq also required

set -uo pipefail

# Overall timeout: kill the test after 10 minutes to prevent indefinite hangs
( sleep 600 && kill -TERM $$ 2>/dev/null ) &
WATCHDOG_PID=$!

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR=$(mktemp -d)
MODE="ts"

if [[ "${1:-}" == "--shell" ]]; then
  MODE="shell"
fi

# --- Test counters ---
PASS=0
FAIL=0
TOTAL=0

# --- Cleanup ---
cleanup() {
  kill "$WATCHDOG_PID" 2>/dev/null || true
  jobs -rp | xargs -r kill 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

# --- Helpers ---
log() { echo "[e2e] $*" >&2; }

assert_eq() {
  local expected="$1" actual="$2" msg="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
    log "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    log "  FAIL: $msg (expected='$expected', actual='$actual')"
  fi
}

assert_true() {
  local condition="$1" msg="$2"
  TOTAL=$((TOTAL + 1))
  if [[ "$condition" -ne 0 ]]; then
    PASS=$((PASS + 1))
    log "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    log "  FAIL: $msg"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$haystack" == *"$needle"* ]]; then
    PASS=$((PASS + 1))
    log "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    log "  FAIL: $msg (output does not contain '$needle')"
  fi
}

assert_cmd_ok() {
  local msg="$1"
  shift
  TOTAL=$((TOTAL + 1))
  if "$@" >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    log "  PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    log "  FAIL: $msg (command failed: $*)"
  fi
}

# =========================================================================
# Phase 0: Prerequisites
# =========================================================================
log "Phase 0: Prerequisites (mode=$MODE)"

REQUIRED_CMDS=(jq python3 node npx)
if [[ "$MODE" == "shell" ]]; then
  REQUIRED_CMDS+=(claude yq)
fi

for cmd in "${REQUIRED_CMDS[@]}"; do
  if ! command -v "$cmd" &>/dev/null; then
    log "ERROR: '$cmd' is required but not found in PATH"
    exit 2
  fi
done
log "  All required tools found"

# Source credentials and bridge env var names
if [[ ! -f "$REPO_ROOT/.env.local" ]]; then
  log "ERROR: .env.local not found at $REPO_ROOT/.env.local"
  exit 2
fi
# shellcheck source=/dev/null
source "$REPO_ROOT/.env.local"

# Bridge: .env.local uses SOURCEGRAPH_ACCESS_TOKEN; both shell and TS paths expect SRC_ACCESS_TOKEN
export SRC_ACCESS_TOKEN="${SOURCEGRAPH_ACCESS_TOKEN:-}"

if [[ -z "${SOURCEGRAPH_URL:-}" || -z "${SRC_ACCESS_TOKEN:-}" ]]; then
  log "ERROR: SOURCEGRAPH_URL and SOURCEGRAPH_ACCESS_TOKEN must be set in .env.local"
  exit 2
fi
log "  Credentials loaded (instance: $SOURCEGRAPH_URL)"

# =========================================================================
# Phase 1: Run the full pipeline
# =========================================================================
log ""
log "Phase 1: Running invariant verifier against live Sourcegraph..."
log "  (this may take 2-5 minutes)"

VERIFY_EXIT=0
if [[ "$MODE" == "shell" ]]; then
  "$REPO_ROOT/scripts/verify-invariants.sh" -v -T 90 -P 2 \
    > "$WORK_DIR/report.json" \
    2> "$WORK_DIR/stderr.log" || VERIFY_EXIT=$?
else
  npx tsx "$REPO_ROOT/src/index.ts" --mode=cli \
    > "$WORK_DIR/report.json" \
    2> "$WORK_DIR/stderr.log" || VERIFY_EXIT=$?
fi

log "  Pipeline exited with code $VERIFY_EXIT"
log "  Report saved to $WORK_DIR/report.json"

# Canary is critical+fail, so exitCodeForReport returns 1
assert_eq "1" "$VERIFY_EXIT" "Pipeline exit code is 1 (critical violations present)"

# Check we got output at all
if [[ ! -s "$WORK_DIR/report.json" ]]; then
  log "ERROR: report.json is empty — pipeline produced no output"
  log "--- stderr ---"
  cat "$WORK_DIR/stderr.log" >&2
  exit 2
fi

# Show stderr for debugging
if [[ -s "$WORK_DIR/stderr.log" ]]; then
  log "--- pipeline stderr ---"
  cat "$WORK_DIR/stderr.log" >&2
  log "--- end stderr ---"
fi

# =========================================================================
# Phase 2: Report assertions
# =========================================================================
log ""
log "Phase 2: Report structure assertions"

REPORT="$WORK_DIR/report.json"

# Test 1: Valid JSON with required top-level fields
# TS path has: timestamp, summary, results (no complete field)
# Shell path has: timestamp, summary, results, complete
assert_cmd_ok "Report has required top-level fields" \
  jq -e '.timestamp and .summary and .results' "$REPORT"

# Test 2: Summary counters are consistent
SUMMARY_TOTAL=$(jq -r '.summary.total' "$REPORT")
RESULT_COUNT=$(jq '.results | length' "$REPORT")
assert_eq "$SUMMARY_TOTAL" "$RESULT_COUNT" "summary.total matches results array length"

PASSED_COUNT=$(jq '.summary.passed' "$REPORT")
FAILED_COUNT=$(jq '.summary.failed' "$REPORT")
ERRORS_COUNT=$(jq '.summary.errors' "$REPORT")
COMPUTED_TOTAL=$((PASSED_COUNT + FAILED_COUNT + ERRORS_COUNT))

# Shell path includes checked/timeouts/skipped; TS path sums to total directly
if [[ "$MODE" == "shell" ]]; then
  CHECKED=$(jq '.summary.checked' "$REPORT")
  TIMEOUTS_COUNT=$(jq '.summary.timeouts // 0' "$REPORT")
  COMPUTED_CHECKED=$((PASSED_COUNT + FAILED_COUNT + ERRORS_COUNT + TIMEOUTS_COUNT))
  assert_eq "$CHECKED" "$COMPUTED_CHECKED" "summary.checked == passed + failed + errors + timeouts"
else
  assert_eq "$SUMMARY_TOTAL" "$COMPUTED_TOTAL" "summary.total == passed + failed + errors"
fi

# Test 3: Canary invariant has status "fail"
CANARY_STATUS=$(jq -r '.results[] | select(.id | startswith("canary-")) | .status' "$REPORT")
assert_eq "fail" "$CANARY_STATUS" "Canary invariant must fail (pipeline integrity check)"

# Test 4: Canary has >= 1 violation
CANARY_VIOLATIONS=$(jq '.results[] | select(.id | startswith("canary-")) | .violations | length' "$REPORT")
assert_true "${CANARY_VIOLATIONS:-0}" "Canary has at least 1 violation (got ${CANARY_VIOLATIONS:-0})"

# Test 5: At least one non-canary invariant is not error/timeout
NON_CANARY_TOTAL=$(jq '[.results[] | select(.id | startswith("canary-") | not)] | length' "$REPORT")
NON_CANARY_MEANINGFUL=$(jq '[.results[] | select(.id | startswith("canary-") | not) | select(.status == "pass" or .status == "fail")] | length' "$REPORT")
assert_true "${NON_CANARY_MEANINGFUL:-0}" "At least 1 non-canary invariant produced pass/fail (got ${NON_CANARY_MEANINGFUL:-0}/${NON_CANARY_TOTAL:-0})"

# Test 6: Each result has required fields
assert_cmd_ok "Every result has id, description, severity, status, violations" \
  jq -e '[.results[] | .id and .description and .severity and .status and .violations] | all' "$REPORT"

# =========================================================================
# Phase 3: PR comment dry run
# =========================================================================
log ""
log "Phase 3: PR comment formatting (--format-only)"

PR_EXIT=0
"$REPO_ROOT/scripts/post-github-comment.sh" --format-only test-owner/test-repo 999 \
  < "$REPORT" > "$WORK_DIR/pr-comment.md" 2>/dev/null || PR_EXIT=$?

assert_eq "0" "$PR_EXIT" "post-github-comment.sh --format-only exits 0"

PR_CONTENT=$(cat "$WORK_DIR/pr-comment.md")
assert_true "${#PR_CONTENT}" "PR comment output is non-empty"
assert_contains "$PR_CONTENT" "Cross-Repo Invariant Check" "PR comment contains header"
assert_contains "$PR_CONTENT" "|" "PR comment contains markdown table"
assert_contains "$PR_CONTENT" "canary-verification-active" "PR comment mentions canary invariant"

# =========================================================================
# Phase 4: Slack dry run (local HTTP sink)
# =========================================================================
log ""
log "Phase 4: Slack payload formatting (local HTTP sink)"

SLACK_PORT=18923

python3 -c "
import http.server, sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        with open('$WORK_DIR/slack-payload.json', 'wb') as f:
            f.write(body)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', $SLACK_PORT), Handler)
server.handle_request()
" &
SINK_PID=$!
sleep 1

SLACK_EXIT=0
SLACK_WEBHOOK_URL="http://127.0.0.1:$SLACK_PORT/slack-test" \
  "$REPO_ROOT/scripts/post-slack.sh" < "$REPORT" 2>/dev/null || SLACK_EXIT=$?

wait "$SINK_PID" 2>/dev/null || true

assert_eq "0" "$SLACK_EXIT" "post-slack.sh exits 0 with local webhook"

if [[ -f "$WORK_DIR/slack-payload.json" ]]; then
  assert_cmd_ok "Slack payload is valid JSON" jq -e . "$WORK_DIR/slack-payload.json"
  assert_cmd_ok "Slack payload has attachments" jq -e '.attachments' "$WORK_DIR/slack-payload.json"

  SLACK_COLOR=$(jq -r '.attachments[0].color' "$WORK_DIR/slack-payload.json")
  assert_eq "danger" "$SLACK_COLOR" "Slack attachment color is 'danger' (canary fails)"
else
  TOTAL=$((TOTAL + 3))
  FAIL=$((FAIL + 3))
  log "  FAIL: Slack payload file not captured"
fi

# =========================================================================
# Phase 5: Negative tests
# =========================================================================
log ""
log "Phase 5: Negative tests"

if [[ "$MODE" == "shell" ]]; then
  MISSING_ERR=""
  MISSING_EXIT=0
  MISSING_ERR=$(SRC_ACCESS_TOKEN="" SOURCEGRAPH_URL="$SOURCEGRAPH_URL" \
    "$REPO_ROOT/scripts/verify-invariants.sh" 2>&1) || MISSING_EXIT=$?

  assert_true "$MISSING_EXIT" "Script fails when SRC_ACCESS_TOKEN is empty"
  assert_contains "$MISSING_ERR" "SRC_ACCESS_TOKEN" "Error message mentions SRC_ACCESS_TOKEN"
else
  # Missing token
  MISSING_ERR=""
  MISSING_EXIT=0
  MISSING_ERR=$(SRC_ACCESS_TOKEN="" SOURCEGRAPH_URL="$SOURCEGRAPH_URL" \
    npx tsx "$REPO_ROOT/src/index.ts" --mode=cli 2>&1) || MISSING_EXIT=$?

  assert_true "$MISSING_EXIT" "TS path fails when SRC_ACCESS_TOKEN is empty"
  assert_contains "$MISSING_ERR" "SRC_ACCESS_TOKEN" "Error message mentions SRC_ACCESS_TOKEN"

  # Missing URL
  MISSING_URL_ERR=""
  MISSING_URL_EXIT=0
  MISSING_URL_ERR=$(SRC_ACCESS_TOKEN="fake" SOURCEGRAPH_URL="" \
    npx tsx "$REPO_ROOT/src/index.ts" --mode=cli 2>&1) || MISSING_URL_EXIT=$?

  assert_true "$MISSING_URL_EXIT" "TS path fails when SOURCEGRAPH_URL is empty"
  assert_contains "$MISSING_URL_ERR" "SOURCEGRAPH_URL" "Error message mentions SOURCEGRAPH_URL"

  # Bad config path
  BAD_CFG_ERR=""
  BAD_CFG_EXIT=0
  BAD_CFG_ERR=$(INVARIANTS_CONFIG="/nonexistent/path.json" \
    npx tsx "$REPO_ROOT/src/index.ts" --mode=cli 2>&1) || BAD_CFG_EXIT=$?

  assert_true "$BAD_CFG_EXIT" "TS path fails with nonexistent config file"
fi

# =========================================================================
# Phase 6: YAML config parity (TS path only)
# =========================================================================
if [[ "$MODE" == "ts" ]]; then
  log ""
  log "Phase 6: YAML config parity check"

  # Verify YAML and JSON invariant counts match
  YAML_COUNT=$(python3 -c "
import json, sys
try:
    import yaml
    with open('$REPO_ROOT/invariants.yaml') as f:
        data = yaml.safe_load(f)
    print(len(data.get('invariants', [])))
except ImportError:
    print('skip')
")
  JSON_COUNT=$(jq '.invariants | length' "$REPO_ROOT/invariants.json")

  if [[ "$YAML_COUNT" == "skip" ]]; then
    log "  SKIP: PyYAML not installed, skipping YAML parity check"
  else
    assert_eq "$YAML_COUNT" "$JSON_COUNT" "YAML and JSON have same invariant count ($YAML_COUNT)"

    # Verify IDs match
    YAML_IDS=$(python3 -c "
import yaml
with open('$REPO_ROOT/invariants.yaml') as f:
    data = yaml.safe_load(f)
for inv in data.get('invariants', []):
    print(inv['id'])
" | sort)
    JSON_IDS=$(jq -r '.invariants[].id' "$REPO_ROOT/invariants.json" | sort)

    assert_eq "$YAML_IDS" "$JSON_IDS" "YAML and JSON have matching invariant IDs"
  fi
fi

# =========================================================================
# Summary
# =========================================================================
log ""
log "========================================="
log "  E2E Results: $PASS/$TOTAL passed, $FAIL failed"
log "========================================="

if [[ "$FAIL" -gt 0 ]]; then
  log ""
  log "Report summary:"
  jq '.summary' "$REPORT" >&2
  exit 1
fi
