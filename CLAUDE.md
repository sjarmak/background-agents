# Cross-Repo Invariant Verifier — Agent Instructions

You are verifying a single cross-repo invariant using Sourcegraph MCP tools.
You will be told WHICH invariant to check. This file teaches you HOW.

## Available Tools

- `mcp__sourcegraph__keyword_search` — Search code across all indexed repositories
- `mcp__sourcegraph__find_references` — Find all references to a symbol across repos
- `mcp__sourcegraph__read_file` — Read a specific file from any indexed repository

## Invariant Format

Each invariant in `invariants.json` has this structure:

```json
{
  "id": "unique-name",
  "description": "Human-readable rule",
  "severity": "critical | high | medium | low",
  "search": {
    "pattern": "regex to find candidate code",
    "language": null
  },
  "assertion": {
    "type": "must_contain | must_not_contain | must_not_exist",
    "pattern": "regex for assertion check",
    "scope": "repo | file"
  },
  "message": "Violation explanation"
}
```

## Verification Steps

For the invariant you are assigned:

1. **Search**: Use `keyword_search` with the `search.pattern` to find all matches.
   - Use `language` filter when available to reduce false positives.
2. **Assert**: Based on the assertion type:
   - `must_contain` (scope: repo): For each repo with matches, search for the assertion pattern in the same repo. Violation if missing.
   - `must_contain` (scope: file): For each matching file, check if the assertion pattern exists in the same file. Violation if missing.
   - `must_not_contain` (scope: repo): For each repo with matches, search for the assertion pattern. Violation if found.
   - `must_not_contain` (scope: file): For each matching file, search for the assertion pattern in the same file. Violation if found.
   - `must_not_exist`: Any match to the search pattern is itself a violation.
3. **Report**: Collect repo, file path, and line number for each violation.

### Tips

- For `scope: repo`, you only need one positive match of the assertion per repo.
- Search broadly first, then narrow down — Sourcegraph may paginate results.
- If a search returns too many results, try adding language or repo filters.

## Output Contract

You MUST return ONLY a valid JSON object — no markdown fences, no explanation, no surrounding text.

```json
{
  "status": "pass | fail | error",
  "violations": [
    {
      "repo": "owner/name",
      "file": "path/to/file",
      "line": 42,
      "detail": "short description"
    }
  ]
}
```

- If no violations: `{"status": "pass", "violations": []}`
- If violations found: `{"status": "fail", "violations": [...]}`
- If an error occurs: `{"status": "error", "violations": [], "error": "description"}`
