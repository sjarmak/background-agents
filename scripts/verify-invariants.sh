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
#   -v        Verbose mode (print progress to stderr)
#
# Environment:
#   SOURCEGRAPH_ENDPOINT — Sourcegraph instance URL
#   SOURCEGRAPH_TOKEN    — Sourcegraph access token
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
VERBOSE=false

# --- Parse args ---
while getopts "c:m:s:t:v" opt; do
  case "$opt" in
    c) CONFIG_FILE="$OPTARG" ;;
    m) MCP_CONFIG="$OPTARG" ;;
    s) SCHEMA_FILE="$OPTARG" ;;
    t) MAX_TURNS="$OPTARG" ;;
    v) VERBOSE=true ;;
    *) echo "Usage: $0 [-c config] [-m mcp-config] [-s schema] [-t max-turns] [-v]" >&2; exit 1 ;;
  esac
done

# Resolve paths relative to repo root
[[ "$CONFIG_FILE" != /* ]] && CONFIG_FILE="$REPO_ROOT/$CONFIG_FILE"
[[ "$MCP_CONFIG" != /* ]] && MCP_CONFIG="$REPO_ROOT/$MCP_CONFIG"
[[ "$SCHEMA_FILE" != /* ]] && SCHEMA_FILE="$REPO_ROOT/$SCHEMA_FILE"

# --- Validate prerequisites ---
for cmd in claude yq jq python3; do
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

# --- Process each invariant ---
RESULTS="[]"
PASS_COUNT=0
FAIL_COUNT=0
ERROR_COUNT=0

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

  log "Checking [$((i+1))/$INVARIANT_COUNT]: $INV_ID ($INV_SEVERITY)"

  # Build language filter line (only if set)
  LANG_FILTER=""
  if [[ -n "$INV_LANG" ]]; then
    LANG_FILTER="Filter results to language: $INV_LANG."
  fi

  # Construct per-invariant prompt.
  # CLAUDE.md teaches the agent HOW to verify; this prompt tells it WHAT to check.
  PROMPT="Verify this cross-repo invariant using the instructions in CLAUDE.md.

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

Return ONLY a JSON object per the Output Contract in CLAUDE.md."

  # Call claude CLI with Sourcegraph MCP (one call per invariant for isolation)
  CLAUDE_OUTPUT=""
  if CLAUDE_OUTPUT=$(echo "$PROMPT" | claude -p --bare \
    --mcp-config "$MCP_CONFIG" \
    --max-turns "$MAX_TURNS" \
    --allowedTools "mcp__sourcegraph__keyword_search,mcp__sourcegraph__find_references,mcp__sourcegraph__read_file" \
    2>/dev/null); then

    # Extract JSON from Claude's response — handles multi-line JSON, markdown
    # fences, and preamble text. Finds the first valid JSON object containing "status".
    RESULT_JSON=$(python3 -c '
import sys, json
raw = sys.stdin.read()
# Try parsing the entire output as JSON first
try:
    obj = json.loads(raw)
    if isinstance(obj, dict) and "status" in obj:
        print(json.dumps(obj))
        sys.exit(0)
except (json.JSONDecodeError, ValueError):
    pass
# Fallback: scan for first { and try parsing from each occurrence
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
      STATUS=$(echo "$RESULT_JSON" | jq -r '.status')
      VIOLATIONS=$(echo "$RESULT_JSON" | jq '.violations')
    else
      log "Warning: Could not parse Claude output for $INV_ID, treating as error"
      STATUS="error"
      VIOLATIONS="[]"
    fi
  else
    log "Warning: Claude CLI failed for $INV_ID"
    STATUS="error"
    VIOLATIONS="[]"
  fi

  # Tally
  case "$STATUS" in
    pass) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    fail) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    *)    ERROR_COUNT=$((ERROR_COUNT + 1)) ;;
  esac

  # Append to results array
  ENTRY=$(jq -n \
    --arg id "$INV_ID" \
    --arg desc "$INV_DESC" \
    --arg severity "$INV_SEVERITY" \
    --arg status "$STATUS" \
    --arg message "$INV_MESSAGE" \
    --argjson violations "${VIOLATIONS:-[]}" \
    '{id: $id, description: $desc, severity: $severity, status: $status, message: $message, violations: $violations}')

  RESULTS=$(echo "$RESULTS" | jq --argjson entry "$ENTRY" '. + [$entry]')

  log "  → $STATUS ($(echo "${VIOLATIONS:-[]}" | jq 'length') violations)"
done

# --- Build final report ---
REPORT=$(jq -n \
  --argjson results "$RESULTS" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson total "$INVARIANT_COUNT" \
  --argjson passed "$PASS_COUNT" \
  --argjson failed "$FAIL_COUNT" \
  --argjson errors "$ERROR_COUNT" \
  '{
    timestamp: $timestamp,
    summary: {total: $total, passed: $passed, failed: $failed, errors: $errors},
    results: $results
  }')

echo "$REPORT"

# Exit with non-zero if any failures OR errors (fail closed, not open)
if [[ "$FAIL_COUNT" -gt 0 || "$ERROR_COUNT" -gt 0 ]]; then
  log "Exiting with failure: $FAIL_COUNT failed, $ERROR_COUNT errors"
  exit 1
fi
