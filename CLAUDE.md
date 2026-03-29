# Cross-Repo Invariant Verifier — Agent Instructions

You are verifying cross-repo invariants using Sourcegraph MCP tools.

## Available Tools

- `mcp__sourcegraph__keyword_search` — Search code across all indexed repositories
- `mcp__sourcegraph__find_references` — Find all references to a symbol across repos
- `mcp__sourcegraph__read_file` — Read a specific file from any indexed repository

## How to Verify Invariants

Each invariant in `.github/invariants.yml` has this structure:

```yaml
- id: unique-name
  search:
    pattern: "regex to find candidate code"
    language: "" # optional language filter
  assertion:
    must_contain: "regex that must also exist" # OR
    must_not_contain: "regex that must NOT exist" # OR
    must_not_exist: true # no matches allowed at all
    scope: repo | file # check assertion at repo or file level
  message: "Human-readable violation explanation"
  severity: critical | high | medium | low
```

### Verification Steps

For each invariant:

1. **Search**: Use `keyword_search` with the `search.pattern` to find all matches
2. **Assert**: Based on the assertion type:
   - `must_contain` (scope: repo): For each repo with matches, search for the assertion pattern in the same repo. Violation if missing.
   - `must_contain` (scope: file): For each matching file, check if the assertion pattern exists in the same file. Violation if missing.
   - `must_not_contain` (scope: repo): For each repo with matches, search for the assertion pattern. Violation if found.
   - `must_not_exist`: Any match to the search pattern is itself a violation.
3. **Report**: Collect repo, file path, and line number for each violation.

### Tips

- Use `language` filter when available to reduce false positives
- For `scope: repo`, you only need one positive match of the assertion per repo
- Search broadly first, then narrow down — Sourcegraph may paginate results
- If a search returns too many results, try adding language or repo filters
- Prioritize by severity: check `critical` invariants first

## Output Format

### PR Comment (CI trigger)

Keep it scannable:

```
## Cross-Repo Invariant Check

✅ **3 invariants passed** | ❌ **1 violation found**

| Invariant | Status | Details |
|-----------|--------|---------|
| auth-init-required | ✅ Pass | 12 repos checked |
| no-dual-db-clients | ❌ FAIL | 2 repos in violation |
| ... | ... | ... |

### Violations

**no-dual-db-clients** (high severity)
- `payments-service` — imports both clients in `src/db/connection.ts:14`
- `user-service` — imports both clients in `lib/database.go:8`

> Fix: Choose one database client per repository.
```

### Weekly Report (scheduled)

Include totals, trends if possible, and group violations by team/codeowner.
