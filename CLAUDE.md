# Cross-Repo Invariant Verifier — Agent Instructions

> **What is this?** The Cross-Repo Invariant Verifier is a background agent that
> checks organization-wide code invariants across every Sourcegraph-indexed
> repository, triggered by GitHub PR events and a weekly cron, emitting a
> strict-JSON violation report. See [`README.md`](./README.md) for the full
> architecture, CI integration, and repository layout.

You are verifying cross-repo invariants against Sourcegraph.

## Backends

The verifier reaches Sourcegraph through one of two backends, selected at
startup in [`src/index.ts`](./src/index.ts):

- **GraphQL (default)** — `SourcegraphGraphQLClient`, used whenever the `--mcp`
  flag is absent (`src/index.ts`: `process.argv.includes("--mcp") ? "mcp" : "graphql"`).
  It calls the Sourcegraph GraphQL API directly; no Claude agent or MCP server is
  involved. Both GitHub workflows (the PR check and the weekly scheduled run) run
  this path.
- **MCP (opt-in)** — `SourcegraphMCPClient`, enabled with the `--mcp` flag. It
  drives a Claude agent equipped with the Sourcegraph MCP tools listed below.
  No workflow passes `--mcp`; this path is for manual runs only.

The tool-driven verification instructions in this file apply to the **MCP path**.
On the default GraphQL path the same invariant semantics run in code via the
`InvariantEngine` rather than through an agent — but the invariant schema and the
JSON output contract below are identical for both.

## Available Tools (MCP path)

- `mcp__sourcegraph__sg_keyword_search` — Search code across all indexed repositories
- `mcp__sourcegraph__sg_find_references` — Find all references to a symbol across repos
- `mcp__sourcegraph__sg_read_file` — Read a specific file from any indexed repository

## How to Verify Invariants

Each invariant in `config/invariants.json` has this structure:

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
  "message": "Violation explanation shown to engineers"
}
```

### Verification Steps

For each invariant:

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
- Prioritize by severity: check `critical` invariants first.

### Output Contract

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

## Build & test commands

```bash
npm ci                  # install pinned dependencies
npm run build           # compile TypeScript to dist/ (tsc)
npx tsc --noEmit        # typecheck only (CI gate, no emit)
npm test                # run unit tests (vitest run)
npm run test:coverage   # unit tests with coverage (vitest run --coverage)
npm run verify          # one-shot CLI verification, JSON report to stdout (tsx src/index.ts --mode=cli)
npm run dev             # run the entrypoint via tsx, no build step
```

Run against the MCP backend instead of the default GraphQL path:

```bash
npx tsx src/index.ts --mode=cli --mcp
```

`SOURCEGRAPH_URL` and `SRC_ACCESS_TOKEN` must be set in the environment for any
verification run (see `README.md` §Quick start).

## Code style

- **TypeScript, strict mode** (`tsconfig.json` `"strict": true`), targeting
  ES2022 with `NodeNext` modules. Source lives in `src/`, compiles to `dist/`.
- **ESM throughout** — `package.json` sets `"type": "module"`; relative imports
  use explicit `.js` extensions (e.g. `./sourcegraph-client.js`) as `NodeNext`
  resolution requires.
- Explicit types on exported functions and public APIs; let local inference
  handle the rest. Avoid `any` — narrow `unknown` instead.
- Config and external input are validated with **Zod**.
- Diagnostics go to **stderr** (`console.error`); only the strict-JSON report
  goes to **stdout** (`console.log`), so the output contract above stays
  machine-parseable.

## Output Formats (for report consumers)

### PR Comment (CI trigger)

```
## Cross-Repo Invariant Check

✅ **3 invariants passed** | ❌ **1 violation found**

| Invariant | Status | Details |
|-----------|--------|---------|
| auth-init-required | ✅ Pass | 12 repos checked |
| no-dual-db-clients | ❌ FAIL | 2 repos in violation |

### Violations

**no-dual-db-clients** (high severity)
- `payments-service` — imports both clients in `src/db/connection.ts:14`
- `user-service` — imports both clients in `lib/database.go:8`

> Fix: Choose one database client per repository.
```

### Canary Invariant

The invariant with id `canary-*` is a synthetic test. It MUST always find a violation.
If your verification of a canary invariant finds zero matches, something is wrong with
the Sourcegraph connection or search. Report status "fail" with a violation for canary invariants.

### Weekly Report (scheduled)

Include totals, trends if possible, and group violations by team/codeowner.
