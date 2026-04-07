#!/usr/bin/env bash
# verify-invariants.sh — Main orchestrator for cross-repo invariant verification.
#
# Reads invariants from JSON, constructs a per-invariant prompt for Claude CLI
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
#   -c FILE   Invariants config file (default: invariants.json)
#   -m FILE   MCP config file (default: mcp-config.json)
#   -s FILE   Schema file for validation (default: invariants.schema.json)
#   -t N      Max turns per invariant check (default: 10)
#   -T N      Per-invariant timeout in seconds (default: 120)
#   -P N      Max parallel jobs (default: 4)
#   -v        Verbose mode (print progress to stderr)
#
# Environment:
#   SOURCEGRAPH_URL      — Sourcegraph instance URL
#   SRC_ACCESS_TOKEN     — Sourcegraph access token
#
# Output: JSON report to stdout
#   { "timestamp": "...", "summary": {...}, "results": [...] }

set -euo pipefail

# --- Require bash 4.3+ for wait -n ---
if [[ "${BASH_VERSINFO[0]}" -lt 4 || ( "${BASH_VERSINFO[0]}" -eq 4 && "${BASH_VERSINFO[1]}" -lt 3 ) ]]; then
  echo "Error: bash 4.3+ required (found $BASH_VERSION)" >&2
  exit 1
fi

# --- Defaults ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="invariants.json"
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

# --- Validate numeric options ---
for var_name in MAX_TURNS PER_TIMEOUT MAX_PARALLEL; do
  val="${!var_name}"
  if [[ ! "$val" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: -${var_name} requires a positive integer, got: $val" >&2
    exit 1
  fi
done

# Resolve paths relative to repo root
[[ "$CONFIG_FILE" != /* ]] && CONFIG_FILE="$REPO_ROOT/$CONFIG_FILE"
[[ "$MCP_CONFIG" != /* ]] && MCP_CONFIG="$REPO_ROOT/$MCP_CONFIG"
[[ "$SCHEMA_FILE" != /* ]] && SCHEMA_FILE="$REPO_ROOT/$SCHEMA_FILE"

# --- Validate prerequisites ---
for cmd in claude jq python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not found in PATH" >&2
    exit 1
  fi
done
if ! command -v ajv &>/dev/null; then
  echo "Warning: 'ajv' not found — schema validation will be skipped" >&2
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

if [[ ! -f "$MCP_CONFIG" ]]; then
  echo "Error: MCP config not found: $MCP_CONFIG" >&2
  exit 1
fi

if [[ -z "${SOURCEGRAPH_URL:-}" || -z "${SRC_ACCESS_TOKEN:-}" ]]; then
  echo "Error: SOURCEGRAPH_URL and SRC_ACCESS_TOKEN must be set" >&2
  exit 1
fi

# --- Validate config against JSON Schema ---
if command -v ajv &>/dev/null && [[ -f "$SCHEMA_FILE" ]]; then
  if ! ajv validate -s "$SCHEMA_FILE" -d "$CONFIG_FILE" --spec=draft2020 2>/dev/null; then
    echo "Error: invariants config failed schema validation" >&2
    echo "Run: ajv validate -s $SCHEMA_FILE -d $CONFIG_FILE" >&2
    exit 1
  fi
  [[ "$VERBOSE" == "true" ]] && echo "[verify] Config passed schema validation" >&2
else
  echo "Warning: schema file not found at $SCHEMA_FILE — skipping validation" >&2
fi

# --- Helpers ---
log() {
  if [[ "$VERBOSE" == "true" ]]; then
    echo "[verify] $*" >&2
  fi
}

emit_canary_error() {
  local msg="$1"
  echo "Error: $msg" >&2
  jq -n --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg error "$msg" \
    '{timestamp: $timestamp,
      summary: {total: 0, checked: 0, passed: 0, failed: 0, errors: 1, skipped: 0, timeouts: 0},
      complete: false, results: [], error: $error}'
  exit 1
}

# --- Read invariant count ---
INVARIANT_COUNT=$(jq '.invariants | length' "$CONFIG_FILE")
log "Found $INVARIANT_COUNT invariants to verify"

# --- Empty config guard ---
if [[ "$INVARIANT_COUNT" -eq 0 ]]; then
  echo "Error: No invariants found in $CONFIG_FILE" >&2
  exit 1
fi

# --- Sourcegraph circuit breaker ---
log "Running Sourcegraph connectivity check..."
SG_CANARY_OUTPUT=""
if ! SG_CANARY_OUTPUT=$(timeout 10 claude -p --bare \
  --mcp-config "$MCP_CONFIG" \
  --allowedTools "mcp__sourcegraph__sg_keyword_search" \
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

# --- Pre-parse all invariants from YAML once ---
INVARIANTS_JSON=$(jq '.invariants' "$CONFIG_FILE")

# Detect canary invariants and collect all IDs
CANARY_IDS=()
INV_IDS=()
for i in $(seq 0 $((INVARIANT_COUNT - 1))); do
  _id=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].id")
  INV_IDS+=("$_id")
  if [[ "$_id" == canary-* ]]; then
    CANARY_IDS+=("$_id")
    log "Detected canary invariant: $_id"
  fi
done

# --- Parallel execution setup ---
WORK_DIR=$(mktemp -d)
trap 'kill -- -$$ 2>/dev/null; rm -rf "$WORK_DIR"' EXIT INT TERM

# Write per-invariant prompts and spawn background jobs
log "Launching invariant checks (max $MAX_PARALLEL parallel)..."

for i in $(seq 0 $((INVARIANT_COUNT - 1))); do
  # Extract all fields via discrete jq calls against pre-parsed JSON
  INV_ID=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].id") || { echo "Error: failed to parse invariant $i" >&2; exit 1; }
  INV_DESC=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].description")
  INV_SEVERITY=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].severity")
  INV_SEARCH=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].search.pattern")
  INV_LANG=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].search.language // \"\"")
  INV_ASSERT_TYPE=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].assertion.type")
  INV_ASSERT_PATTERN=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].assertion.pattern // \"\"")
  INV_ASSERT_SCOPE=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].assertion.scope // \"repo\"")
  INV_MESSAGE=$(echo "$INVARIANTS_JSON" | jq -r ".[$i].message")

  # Validate INV_ID matches schema contract: lowercase, digits, hyphens
  if [[ ! "$INV_ID" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo "Error: invariant id '$INV_ID' contains illegal characters (must match ^[a-z][a-z0-9-]*$)" >&2
    exit 1
  fi

  log "Spawning [$((i+1))/$INVARIANT_COUNT]: $INV_ID ($INV_SEVERITY)"

  # Build language filter line (only if set)
  LANG_FILTER=""
  if [[ -n "$INV_LANG" ]]; then
    LANG_FILTER="Filter results to language: $INV_LANG."
  fi

  # Write prompt to temp file
  cat > "$WORK_DIR/prompt-$INV_ID.txt" <<PROMPT_EOF
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
    > "$WORK_DIR/meta-$INV_ID.json"

  # Semaphore — wait for a slot before spawning
  while [[ $(jobs -rp | wc -l) -ge "$MAX_PARALLEL" ]]; do
    wait -n
  done

  # Spawn background job with timeout
  (
    CLAUDE_OUTPUT=""
    TIMED_OUT=false
    if CLAUDE_OUTPUT=$(timeout "$PER_TIMEOUT" claude -p --bare \
      --mcp-config "$MCP_CONFIG" \
      --max-turns "$MAX_TURNS" \
      --allowedTools "mcp__sourcegraph__sg_keyword_search,mcp__sourcegraph__sg_find_references,mcp__sourcegraph__sg_read_file" \
      < "$WORK_DIR/prompt-$INV_ID.txt" \
      2>/dev/null); then
      :
    else
      EXIT_CODE=$?
      if [[ "$EXIT_CODE" -eq 124 ]]; then
        TIMED_OUT=true
      fi
    fi

    if [[ "$TIMED_OUT" == "true" ]]; then
      echo '{"status":"timeout","violations":[]}' > "$WORK_DIR/result-$INV_ID.json"
    elif [[ -n "$CLAUDE_OUTPUT" ]]; then
      # Claude may prepend prose before the JSON despite the output contract — scan for first valid object
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
        echo "$RESULT_JSON" > "$WORK_DIR/result-$INV_ID.json"
      else
        echo '{"status":"error","violations":[]}' > "$WORK_DIR/result-$INV_ID.json"
      fi
    else
      echo '{"status":"error","violations":[]}' > "$WORK_DIR/result-$INV_ID.json"
    fi
  ) &
done

# Wait for all remaining background jobs
wait

# --- Merge results ---
log "All jobs complete. Merging results..."

PASS_COUNT=0
FAIL_COUNT=0
ERROR_COUNT=0
TIMEOUT_COUNT=0
CHECKED_COUNT=0
SKIPPED_COUNT=0

# Build merged result files for single-pass jq merge
RESULT_FILES=()
for INV_ID in "${INV_IDS[@]}"; do
  RESULT_FILE="$WORK_DIR/result-$INV_ID.json"
  META_FILE="$WORK_DIR/meta-$INV_ID.json"

  if [[ ! -f "$RESULT_FILE" ]]; then
    log "Warning: No result file for $INV_ID, marking as skipped"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    echo '{"status":"skipped","violations":[]}' > "$RESULT_FILE"
  else
    CHECKED_COUNT=$((CHECKED_COUNT + 1))
    STATUS=$(jq -r '.status' "$RESULT_FILE")
    case "$STATUS" in
      pass)    PASS_COUNT=$((PASS_COUNT + 1)) ;;
      fail)    FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
      timeout) TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1)) ;;
      *)       ERROR_COUNT=$((ERROR_COUNT + 1)) ;;
    esac
    log "  $INV_ID → $STATUS ($(jq '.violations | length' "$RESULT_FILE") violations)"
  fi

  # Merge meta + result into a combined file
  jq -s '.[0] + .[1]' "$META_FILE" "$RESULT_FILE" > "$WORK_DIR/merged-$INV_ID.json"
  RESULT_FILES+=("$WORK_DIR/merged-$INV_ID.json")
done

# Single jq call to produce the results array
RESULTS=$(jq -s '.' "${RESULT_FILES[@]}")

# --- Canary validation ---
for CANARY_ID in "${CANARY_IDS[@]}"; do
  CANARY_RESULT_FILE="$WORK_DIR/result-$CANARY_ID.json"
  if [[ ! -f "$CANARY_RESULT_FILE" ]]; then
    emit_canary_error "Canary invariant '$CANARY_ID' produced no result — pipeline integrity unknown"
  fi
  CANARY_STATUS=$(jq -r '.status' "$CANARY_RESULT_FILE")
  if [[ "$CANARY_STATUS" == "pass" ]]; then
    emit_canary_error "Canary invariant '$CANARY_ID' passed unexpectedly — pipeline integrity compromised"
  fi
done

# --- Completeness tracking ---
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
