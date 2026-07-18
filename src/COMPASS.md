---
compass_area: "src — verifier core"
area_path: "src/"
generated: "2026-07-17"
# Staleness stamp — machine-readable so a refresh can test drift without a model.
# `sources` are area-relative paths (relative to THIS file's directory). Recompute:
#   node ../.claude/skills/project-compass/compass-hash.mjs COMPASS.md
sources_hash: "sha256-16:599b4da8e1695584"
sources:
  - ci-trigger.ts
  - index.ts
  - invariant-engine.ts
  - sourcegraph-client.ts
---

# Compass: src — verifier core

> Tribal-knowledge map for `src/`. The *why* and the *gotchas* — read the code
> for *what*, and `AGENTS.md` for the invariant schema and JSON output contract.
> This map covers what neither of those makes obvious: the failure semantics and
> the two-backend structure. The frontmatter stamp makes its staleness testable.

## Purpose

`src/` is the entire verifier core: the entrypoint, two interchangeable Sourcegraph
backends, the invariant execution engine, and the CI glue. It loads a JSON invariant
config, runs each invariant against Sourcegraph, and emits a strict-JSON report plus
an exit code that distinguishes *clean* from *blocking violation* from
*infrastructure failure*. The whole design is fail-closed.

## Key files & entry points

- **`index.ts`** — entrypoint, config loading, backend selection, pre-flight. Start
  here. The load-bearing switch is `--mcp` (backend), not `--mode` (cosmetic).
- **`sourcegraph-client.ts`** — the two backends behind one `SourcegraphSearchClient`
  interface (GraphQL direct-API + MCP agent). Read for batching, truncation, retry,
  and the MCP JSON-extraction contract.
- **`invariant-engine.ts`** — the execution core: Zod-validated config, per-invariant
  isolation, bounded concurrency, the three assertion handlers.
- **`ci-trigger.ts`** — `exitCodeForReport` and PR-comment formatting; the
  report → CI-signal mapping.

## How it connects

- **In:** `config/invariants.json` (Zod-validated in the engine), and env
  `SOURCEGRAPH_URL` + `SRC_ACCESS_TOKEN`. The backend is chosen at startup.
- **Out:** strict JSON to **stdout** (consumed by `post-slack.sh` and the PR
  workflow's marker-upsert comment step), diagnostics to **stderr**, and an exit code
  (0/1/2) to the GitHub Action.
- Both backends implement `SourcegraphSearchClient`, so `InvariantEngine` is
  backend-agnostic. GraphQL is the CI path; MCP (Claude Agent SDK via `mcp-remote` +
  `@anthropic-ai/claude-code`) is manual-only.

## Gotchas & non-obvious constraints

- **Fail closed everywhere.** Search truncation (results hit `RESULT_CAP` = 500, or
  Sourcegraph's `limitHit`) *throws* → a per-invariant error, never a silent
  under-report. A `canary-*` invariant that finds zero matches *throws* — it is a
  synthetic probe that MUST fire; zero means the search path is broken, not a clean
  org. Any errored invariant makes the run exit 2 (infra failure), never a silent pass.
- **stdout is a strict-JSON channel.** Only the report goes to `console.log`;
  everything else is `console.error` (stderr). Break this and the output stops being
  machine-parseable for the downstream scripts.
- **Backend switch is `--mcp`, not `--mode`.** `--mode` (cli/ci) is behaviorally
  identical, kept for compatibility. No workflow passes `--mcp`, so CI always runs
  GraphQL; MCP is for manual runs.
- **Pre-flight guards only the GraphQL path** (`index.ts`: `sg instanceof
  SourcegraphGraphQLClient`). A failed health check exits 2 so CI can post
  "Sourcegraph unreachable" instead of a false violation. The MCP path has no pre-flight.
- **`searchInRepos` batches** N repos into `ceil(N/20)` alternation queries
  (`repo:^(a|b|…)$`, regex-escaped). Truncation in any one batch truncates the whole
  result. Truncation is measured on **flattened line matches**, not `FileMatch` nodes,
  because `count:` caps line-level results.
- **Subtle canary-prefix inconsistency:** the engine and PR formatter test
  `id.startsWith("canary-")` (with the dash); `exitCodeForReport` tests
  `!id.startsWith("canary")` (no dash). They agree under the `canary-*` naming
  convention, but an id like `canaryX` would diverge. Keep canary ids dash-prefixed.
- **MCP responses are parsed defensively:** last assistant message → first `[...]`
  JSON array → Zod validation; any failure throws rather than returning "no matches"
  (a mumbled agent reply must not read as a clean org).
- **Parallel but ordered:** `verifyAll` runs a 4-worker pool over a shared index yet
  writes `results[index]`, so report order matches config order despite concurrency.

## Failure modes seen here

- **Slack Bolt server mode was removed** (`index.ts` header). Scheduled Slack output
  now goes through `post-slack.sh` (curl-to-webhook) in the Action, not an in-process
  bot. Don't reintroduce an in-process server expecting it to post.
- **This code is a graft of two parent designs** (`invariant-engine.ts` /
  `ci-trigger.ts` headers): Parent C (`agent-sdk-service`) architecture + Parent B
  (`cli-hooks`) per-invariant isolation + B's JSON report contract. Where it diverges
  from either parent's conventions, that is deliberate, not drift.
