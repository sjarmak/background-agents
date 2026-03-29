#!/usr/bin/env bash
# verify-invariants.sh — Main orchestrator for cross-repo invariant verification.
#
# Reads invariants from YAML, constructs a per-invariant prompt for Claude CLI
# with Sourcegraph MCP, and outputs a JSON report to stdout.
#
# The agent instructions live in CLAUDE.md — this script constructs a minimal
# per-invariant prompt that tells the agent WHAT to check, while CLAUDE.md
# teaches it HOW to check (tool usage, assertion logic, output contract).
#
# Usage:
#   ./scripts/verify-invariants.sh [options]
#
# Options:
#   -c FILE   Invariants config file (default: invariants.yaml)
#   -m FILE   MCP config file (default: mcp-config.json)
#   -s FILE   Schema file for validation (default: invariants.schema.json)
#   -t N      Max turns per invariant check (default: 10)
#   -T N      Per-invariant timeout in seconds (default: 120)
#   -P N      Max parallel jobs (default: 4)
#   -v        Verbose mode (print progress to stderr)
#
# Environment:
#   SOURCEGRAPH_ENDPOINT — Sourcegraph instance URL
#   SOURCEGRAPH_TOKEN    — Sourcegraph access token
#   MAX_COST_USD         — Maximum estimated cost in USD (default: 50)
#
# Output: JSON report to stdout
#   { "timestamp": "...", "summary": {...}, "results": [...] }

set -euo pipefail

# --- Defaults ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="invariants.yaml"
MCP_CONFIG="mcp-config.json"
SCHEMA_FILE="invariants.schema.json"
MAX_TURNS=10
PER_TIMEOUT=120
MAX_PARALLEL=4
VERBOSE=false

# --- Parse args ---
while getopts "c:m:s:t:T:P:v" opt; do
  case "$opt" in
    c) CONFIG_FILE="$OPTARG" ;;
    m) MCP_CONFIG="$OPTARG" ;;
    s) SCHEMA_FILE="$OPTARG" ;;
    t) MAX_TURNS="$OPTARG" ;;
    T) PER_TIMEOUT="$OPTARG" ;;
    P) MAX_PARALLEL="$OPTARG" ;;
    v) VERBOSE=true ;;
    *) echo "Usage: $0 [-c config] [-m mcp-config] [-s schema] [-t max-turns] [-T timeout] [-P parallel] [-v]" >&2; exit 1 ;;
  esac
done

# Resolve paths relative to repo root
[[ "$CONFIG_FILE" != /* ]] && CONFIG_FILE="$REPO_ROOT/$CONFIG_FILE"
[[ "$MCP_CONFIG" != /* ]] && MCP_CONFIG="$REPO_ROOT/$MCP_CONFIG"
[[ "$SCHEMA_FILE" != /* ]] && SCHEMA_FILE="$REPO_ROOT/$SCHEMA_FILE"

# --- Validate prerequisites ---
for cmd in claude yq jq python3 bc; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not found in PATH" >&2
    exit 1
  fi
done

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

if [[ ! -f "$MCP_CONFIG" ]]; then
  echo "Error: MCP config not found: $MCP_CONFIG" >&2
  exit 1
fi

if [[ -z "${SOURCEGRAPH_ENDPOINT:-}" || -z "${SOURCEGRAPH_TOKEN:-}" ]]; then
  echo "Error: SOURCEGRAPH_ENDPOINT and SOURCEGRAPH_TOKEN must be set" >&2
  exit 1
fi

# --- Validate config against JSON Schema (if ajv-cli available) ---
if command -v ajv &>/dev/null && [[ -f "$SCHEMA_FILE" ]]; then
  log_msg="Validating config against schema..."
  if ! ajv validate -s "$SCHEMA_FILE" -d "$CONFIG_FILE" --spec=draft2020 2>/dev/null; then
    echo "Error: invariants.yaml failed schema validation" >&2
    echo "Run: ajv validate -s $SCHEMA_FILE -d $CONFIG_FILE" >&2
    exit 1
  fi
  [[ "$VERBOSE" == "true" ]] && echo "[verify] Config passed schema validation" >&2
elif [[ "$VERBOSE" == "true" ]]; then
  echo "[verify] Skipping schema validation (ajv not installed)" >&2
fi

# --- Helper: log to stderr if verbose ---
log() {
  if [[ "$VERBOSE" == "true" ]]; then
    echo "[verify] $*" >&2
  fi
}

# --- Read invariant count ---
INVARIANT_COUNT=$(yq '.invariants | length' "$CONFIG_FILE")
log "Found $INVARIANT_COUNT invariants to verify"

# --- Mod 7: Empty config guard ---
if [[ "$INVARIANT_COUNT" -eq 0 ]]; then
  echo "Error: No invariants found in $CONFIG_FILE" >&2
  exit 1
fi

# --- Mod 5: Cost estimation ---
ESTIMATED_COST=$(echo "$INVARIANT_COUNT * 1.5" | bc)
MAX_COST="${MAX_COST_USD:-50}"
if (( $(echo "$ESTIMATED_COST > $MAX_COST" | bc -l) )); then
  echo "Error: Estimated cost \$$ESTIMATED_COST exceeds budget \$$MAX_COST" >&2
  exit 1
fi
log "Estimated cost: \$$ESTIMATED_COST (budget: \$$MAX_COST)"

# --- Mod 6: Sourcegraph circuit breaker ---
log "Running Sourcegraph connectivity check..."
SG_CANARY_OUTPUT=""
if ! SG_CANARY_OUTPUT=$(timeout 10 claude -p --bare \
  --mcp-config "$MCP_CONFIG" \
  --allowedTools "mcp__sourcegraph__keyword_search" \
  "Search for 'main' using keyword_search. Return {\"status\":\"ok\"} if search works." \
  2>/dev/null); then
  echo "Error: Sourcegraph unreachable — circuit breaker tripped (claude call failed)" >&2
  exit 1
fi
if [[ -z "$SG_CANARY_OUTPUT" ]]; then
  echo "Error: Sourcegraph unreachable — circuit breaker tripped (empty response)" >&2
  exit 1
fi
log "Sourcegraph connectivity check passed"

# --- Mod 1: Canary invariant detection ---
# Collect canary invariant indices for post-verification validation
CANARY_IDS=()
for i in $(seq 0 $((INVARIANT_COUNT - 1))); do
  INV_ID=$(yq -r ".invariants[$i].id" "$CONFIG_FILE")
  if [[ "$INV_ID" == canary-* ]]; then
    CANARY_IDS+=("$INV_ID")
    log "Detected canary invariant: $INV_ID"
  fi
done

# --- Mod 4: Parallel execution setup ---
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Write per-invariant prompts and spawn background jobs
log "Launching invariant checks (max $MAX_PARALLEL parallel)..."

ACTIVE_JOBS=0

for i in $(seq 0 $((INVARIANT_COUNT - 1))); do
  # Extract invariant fields
  INV_ID=$(yq -r ".invariants[$i].id" "$CONFIG_FILE")
  INV_DESC=$(yq -r ".invariants[$i].description" "$CONFIG_FILE")
  INV_SEVERITY=$(yq -r ".invariants[$i].severity" "$CONFIG_FILE")
  INV_SEARCH=$(yq -r ".invariants[$i].search.pattern" "$CONFIG_FILE")
  INV_LANG=$(yq -r ".invariants[$i].search.language // \"\"" "$CONFIG_FILE")
  INV_ASSERT_TYPE=$(yq -r ".invariants[$i].assertion.type" "$CONFIG_FILE")
  INV_ASSERT_PATTERN=$(yq -r ".invariants[$i].assertion.pattern // \"\"" "$CONFIG_FILE")
  INV_ASSERT_SCOPE=$(yq -r ".invariants[$i].assertion.scope // \"repo\"" "$CONFIG_FILE")
  INV_MESSAGE=$(yq -r ".invariants[$i].message" "$CONFIG_FILE")

  log "Spawning [$((i+1))/$INVARIANT_COUNT]: $INV_ID ($INV_SEVERITY)"

  # Build language filter line (only if set)
  LANG_FILTER=""
  if [[ -n "$INV_LANG" ]]; then
    LANG_FILTER="Filter results to language: $INV_LANG."
  fi

  # Write prompt to temp file
  cat > "$TMPDIR/prompt-$INV_ID.txt" <<PROMPT_EOF
Verify this cross-repo invariant using the instructions in CLAUDE.md.

INVARIANT: ${INV_ID}
DESCRIPTION: ${INV_DESC}
SEVERITY: ${INV_SEVERITY}

SEARCH:
  pattern: ${INV_SEARCH}
  ${LANG_FILTER}

ASSERTION:
  type: ${INV_ASSERT_TYPE}
  pattern: ${INV_ASSERT_PATTERN}
  scope: ${INV_ASSERT_SCOPE}

Return ONLY a JSON object per the Output Contract in CLAUDE.md.
PROMPT_EOF

  # Write metadata for result merging
  jq -n \
    --arg id "$INV_ID" \
    --arg desc "$INV_DESC" \
    --arg severity "$INV_SEVERITY" \
    --arg message "$INV_MESSAGE" \
    '{id: $id, description: $desc, severity: $severity, message: $message}' \
    > "$TMPDIR/meta-$INV_ID.json"

  # Spawn background job with timeout (Mod 3)
  (
    CLAUDE_OUTPUT=""
    TIMED_OUT=false
    if CLAUDE_OUTPUT=$(timeout "$PER_TIMEOUT" claude -p --bare \
      --mcp-config "$MCP_CONFIG" \
      --max-turns "$MAX_TURNS" \
      --allowedTools "mcp__sourcegraph__keyword_search,mcp__sourcegraph__find_references,mcp__sourcegraph__read_file" \
      < "$TMPDIR/prompt-$INV_ID.txt" \
      2>/dev/null); then
      :
    else
      EXIT_CODE=$?
      if [[ "$EXIT_CODE" -eq 124 ]]; then
        TIMED_OUT=true
      fi
    fi

    if [[ "$TIMED_OUT" == "true" ]]; then
      echo '{"status":"timeout","violations":[]}' > "$TMPDIR/result-$INV_ID.json"
    elif [[ -n "$CLAUDE_OUTPUT" ]]; then
      # Extract JSON from Claude's response
      RESULT_JSON=$(python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    obj = json.loads(raw)
    if isinstance(obj, dict) and "status" in obj:
        print(json.dumps(obj))
        sys.exit(0)
except (json.JSONDecodeError, ValueError):
    pass
for i, ch in enumerate(raw):
    if ch == "{":
        try:
            obj = json.loads(raw[i:])
            if isinstance(obj, dict) and "status" in obj:
                print(json.dumps(obj))
                sys.exit(0)
        except (json.JSONDecodeError, ValueError):
            continue
print("")
' <<< "$CLAUDE_OUTPUT" 2>/dev/null || echo "")

      if [[ -n "$RESULT_JSON" ]] && echo "$RESULT_JSON" | jq . &>/dev/null; then
        echo "$RESULT_JSON" > "$TMPDIR/result-$INV_ID.json"
      else
        echo '{"status":"error","violations":[]}' > "$TMPDIR/result-$INV_ID.json"
      fi
    else
      echo '{"status":"error","violations":[]}' > "$TMPDIR/result-$INV_ID.json"
    fi
  ) &

  ACTIVE_JOBS=$((ACTIVE_JOBS + 1))

  # Mod 4: Semaphore — wait for a slot when at concurrency cap
  if [[ "$ACTIVE_JOBS" -ge "$MAX_PARALLEL" ]]; then
    wait -n 2>/dev/null || true
    ACTIVE_JOBS=$((ACTIVE_JOBS - 1))
  fi
done

# Wait for all remaining background jobs
wait

# --- Merge results ---
log "All jobs complete. Merging results..."

RESULTS="[]"
PASS_COUNT=0
FAIL_COUNT=0
ERROR_COUNT=0
TIMEOUT_COUNT=0
CHECKED_COUNT=0
SKIPPED_COUNT=0

for i in $(seq 0 $((INVARIANT_COUNT - 1))); do
  INV_ID=$(yq -r ".invariants[$i].id" "$CONFIG_FILE")

  RESULT_FILE="$TMPDIR/result-$INV_ID.json"
  META_FILE="$TMPDIR/meta-$INV_ID.json"

  if [[ ! -f "$RESULT_FILE" ]]; then
    log "Warning: No result file for $INV_ID, marking as skipped"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))

    ENTRY=$(jq -n \
      --slurpfile meta "$META_FILE" \
      '$meta[0] + {status: "skipped", violations: []}')
    RESULTS=$(echo "$RESULTS" | jq --argjson entry "$ENTRY" '. + [$entry]')
    continue
  fi

  CHECKED_COUNT=$((CHECKED_COUNT + 1))

  STATUS=$(jq -r '.status' "$RESULT_FILE")
  VIOLATIONS=$(jq '.violations' "$RESULT_FILE")

  # Tally
  case "$STATUS" in
    pass)    PASS_COUNT=$((PASS_COUNT + 1)) ;;
    fail)    FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    timeout) TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1)) ;;
    *)       ERROR_COUNT=$((ERROR_COUNT + 1)) ;;
  esac

  # Build result entry by merging metadata with result
  ENTRY=$(jq -n \
    --slurpfile meta "$META_FILE" \
    --arg status "$STATUS" \
    --argjson violations "${VIOLATIONS:-[]}" \
    '$meta[0] + {status: $status, violations: $violations}')

  RESULTS=$(echo "$RESULTS" | jq --argjson entry "$ENTRY" '. + [$entry]')

  log "  $INV_ID → $STATUS ($(echo "${VIOLATIONS:-[]}" | jq 'length') violations)"
done

# --- Mod 1: Canary validation ---
for CANARY_ID in "${CANARY_IDS[@]}"; do
  CANARY_RESULT_FILE="$TMPDIR/result-$CANARY_ID.json"
  if [[ -f "$CANARY_RESULT_FILE" ]]; then
    CANARY_STATUS=$(jq -r '.status' "$CANARY_RESULT_FILE")
    if [[ "$CANARY_STATUS" == "pass" ]]; then
      echo "Error: Canary invariant '$CANARY_ID' returned 'pass' — the guaranteed violation was NOT detected. Verification pipeline is broken." >&2
      # Output error report
      jq -n \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg error "Canary invariant '$CANARY_ID' passed unexpectedly — pipeline integrity compromised" \
        '{
          timestamp: $timestamp,
          summary: {total: 0, checked: 0, passed: 0, failed: 0, errors: 1, skipped: 0, timeouts: 0},
          complete: false,
          results: [],
          error: $error
        }'
      exit 1
    fi
  fi
done

# --- Mod 2: Completeness tracking ---
IS_COMPLETE=true
if [[ "$CHECKED_COUNT" -lt "$INVARIANT_COUNT" ]]; then
  IS_COMPLETE=false
fi

# --- Build final report ---
REPORT=$(jq -n \
  --argjson results "$RESULTS" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson total "$INVARIANT_COUNT" \
  --argjson checked "$CHECKED_COUNT" \
  --argjson passed "$PASS_COUNT" \
  --argjson failed "$FAIL_COUNT" \
  --argjson errors "$ERROR_COUNT" \
  --argjson skipped "$SKIPPED_COUNT" \
  --argjson timeouts "$TIMEOUT_COUNT" \
  --argjson complete "$IS_COMPLETE" \
  '{
    timestamp: $timestamp,
    summary: {total: $total, checked: $checked, passed: $passed, failed: $failed, errors: $errors, skipped: $skipped, timeouts: $timeouts},
    complete: $complete,
    results: $results
  }')

echo "$REPORT"

# Exit with non-zero if any failures, errors, or timeouts (fail closed, not open)
if [[ "$FAIL_COUNT" -gt 0 || "$ERROR_COUNT" -gt 0 || "$TIMEOUT_COUNT" -gt 0 ]]; then
  log "Exiting with failure: $FAIL_COUNT failed, $ERROR_COUNT errors, $TIMEOUT_COUNT timeouts"
  exit 1
fi
