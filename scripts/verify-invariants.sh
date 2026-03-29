#!/usr/bin/env bash
# verify-invariants.sh — Main orchestrator for cross-repo invariant verification.
#
# Reads invariants from YAML, constructs a prompt for each, calls claude CLI
# with Sourcegraph MCP, and outputs a JSON report to stdout.
#
# Usage:
#   ./scripts/verify-invariants.sh [options]
#
# Options:
#   -c FILE   Invariants config file (default: invariants.yaml)
#   -m FILE   MCP config file (default: mcp-config.json)
#   -t N      Max turns per invariant check (default: 10)
#   -v        Verbose mode (print progress to stderr)
#
# Environment:
#   SOURCEGRAPH_ENDPOINT — Sourcegraph instance URL
#   SOURCEGRAPH_TOKEN    — Sourcegraph access token
#
# Output: JSON array of results to stdout
#   [{ "id": "...", "status": "pass|fail|error", "violations": [...], "severity": "..." }]

set -euo pipefail

# --- Defaults ---
CONFIG_FILE="invariants.yaml"
MCP_CONFIG="mcp-config.json"
MAX_TURNS=10
VERBOSE=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Parse args ---
while getopts "c:m:t:v" opt; do
  case "$opt" in
    c) CONFIG_FILE="$OPTARG" ;;
    m) MCP_CONFIG="$OPTARG" ;;
    t) MAX_TURNS="$OPTARG" ;;
    v) VERBOSE=true ;;
    *) echo "Usage: $0 [-c config] [-m mcp-config] [-t max-turns] [-v]" >&2; exit 1 ;;
  esac
done

# Resolve paths relative to repo root
[[ "$CONFIG_FILE" != /* ]] && CONFIG_FILE="$REPO_ROOT/$CONFIG_FILE"
[[ "$MCP_CONFIG" != /* ]] && MCP_CONFIG="$REPO_ROOT/$MCP_CONFIG"

# --- Validate prerequisites ---
for cmd in claude yq jq; do
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

  # Build the prompt for Claude
  LANG_FILTER=""
  if [[ -n "$INV_LANG" ]]; then
    LANG_FILTER="Filter results to language: $INV_LANG."
  fi

  PROMPT="You are a cross-repo invariant verifier using Sourcegraph.

INVARIANT: $INV_DESC
SEARCH PATTERN: $INV_SEARCH
$LANG_FILTER

ASSERTION:
- Type: $INV_ASSERT_TYPE
- Pattern: $INV_ASSERT_PATTERN
- Scope: $INV_ASSERT_SCOPE

INSTRUCTIONS:
1. Use keyword_search to find files matching: $INV_SEARCH
2. Based on the assertion type:
   - must_contain: For each match (at $INV_ASSERT_SCOPE level), verify '$INV_ASSERT_PATTERN' also exists. Report any where it does NOT.
   - must_not_contain: For each match (at $INV_ASSERT_SCOPE level), verify '$INV_ASSERT_PATTERN' does NOT exist. Report any where it DOES.
   - must_not_exist: Any search match is itself a violation.
3. Return ONLY a JSON object (no markdown, no explanation):
{
  \"status\": \"pass\" or \"fail\",
  \"violations\": [
    {\"repo\": \"owner/name\", \"file\": \"path/to/file\", \"line\": 42, \"detail\": \"short description\"}
  ]
}
If no violations, return: {\"status\": \"pass\", \"violations\": []}
If an error occurs, return: {\"status\": \"error\", \"violations\": [], \"error\": \"description\"}"

  # Call claude CLI with Sourcegraph MCP
  CLAUDE_OUTPUT=""
  if CLAUDE_OUTPUT=$(echo "$PROMPT" | claude -p --bare \
    --mcp-config "$MCP_CONFIG" \
    --max-turns "$MAX_TURNS" \
    --allowedTools "mcp__sourcegraph__keyword_search,mcp__sourcegraph__find_references,mcp__sourcegraph__read_file" \
    2>/dev/null); then

    # Extract JSON from Claude's response (strip any surrounding text)
    RESULT_JSON=$(echo "$CLAUDE_OUTPUT" | grep -o '{.*}' | head -1 || echo "")

    if [[ -n "$RESULT_JSON" ]] && echo "$RESULT_JSON" | jq . &>/dev/null; then
      STATUS=$(echo "$RESULT_JSON" | jq -r '.status')
      VIOLATIONS=$(echo "$RESULT_JSON" | jq '.violations')
    else
      log "Warning: Could not parse Claude output for $INV_ID, treating as error"
      STATUS="error"
      VIOLATIONS="[]"
      RESULT_JSON="{\"status\":\"error\",\"violations\":[],\"error\":\"unparseable response\"}"
    fi
  else
    log "Warning: Claude CLI failed for $INV_ID"
    STATUS="error"
    VIOLATIONS="[]"
    RESULT_JSON="{\"status\":\"error\",\"violations\":[],\"error\":\"claude cli failed\"}"
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
    --argjson violations "$VIOLATIONS" \
    '{id: $id, description: $desc, severity: $severity, status: $status, message: $message, violations: $violations}')

  RESULTS=$(echo "$RESULTS" | jq --argjson entry "$ENTRY" '. + [$entry]')

  log "  → $STATUS ($(echo "$VIOLATIONS" | jq 'length') violations)"
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

# Exit with non-zero if any failures
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
