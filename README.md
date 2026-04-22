# Cross-Repo Invariant Verifier

A background agent that checks organization-wide code invariants across every
repository indexed by [Sourcegraph](https://sourcegraph.com). Triggered by
GitHub PR events and a weekly cron, driven by an [MCP](https://modelcontextprotocol.io)
tool, and emits a strict-JSON violation report that gets posted as a PR comment
or to Slack.

## What it does

Given a small declarative rules file (`config/invariants.json`) like:

```json
{
  "id": "auth-init-required",
  "description": "Every service importing auth-lib MUST call auth.init()",
  "severity": "critical",
  "search":    { "pattern": "import.*auth-lib", "language": null },
  "assertion": { "type": "must_contain", "pattern": "auth\\.init\\(", "scope": "repo" },
  "message":   "Repository imports auth-lib but never calls auth.init() — silent auth bypass"
}
```

...the verifier uses Sourcegraph (via GraphQL by default, MCP optionally) to
find candidate matches across the fleet, applies the per-repo / per-file
assertion, and reports each violation with `repo`, `file`, `line`, `detail`.

## Architecture

```
GitHub Actions  (PR event  |  weekly cron)
        │
        ▼
  src/index.ts  ── pre-flight health check ──► exit 2 if Sourcegraph unreachable
        │
        ▼
  InvariantEngine  ── per-invariant isolation ──► one failure ≠ all failures
        │
        ▼
  SourcegraphClient  ── GraphQL default / MCP opt-in ──► keyword_search, find_references, read_file
        │
        ▼
  report.json  (strict-JSON contract, see CLAUDE.md)
        │
        ├──► PR comment (idempotent upsert via marker)
        ├──► Slack webhook (scheduled runs)
        └──► GitHub Actions artifact (30-day retention)
```

Exit codes: `0` pass, `1` violations, `2` infrastructure (e.g. Sourcegraph
unreachable). CI treats `2` as distinct from `1` so connectivity issues don't
masquerade as rule violations.

## Quick start

```bash
npm ci
export SOURCEGRAPH_URL="https://sourcegraph.example.com"
export SRC_ACCESS_TOKEN="sgp_..."

# One-shot, JSON to stdout
npm run verify

# Typecheck + unit tests
npx tsc --noEmit
npm test
```

To use the Sourcegraph MCP server instead of the GraphQL path:

```bash
npx tsx src/index.ts --mode=cli --mcp
```

## CI integration

Two workflows in `.github/workflows/`:

| Workflow                          | Trigger                  | Output                         |
| --------------------------------- | ------------------------ | ------------------------------ |
| `invariant-check-pr.yml`          | `pull_request` on code paths + `config/invariants.json` | PR comment (idempotent upsert) + failing check |
| `invariant-check-scheduled.yml`   | Weekly cron (Mon 09:00 UTC) + `workflow_dispatch` | Slack webhook + uploaded artifact |

The PR workflow pins `config/invariants.json` and `CLAUDE.md` to the base branch as a
**trust boundary** so a PR author cannot weaken invariants or agent
instructions in the same PR they want to merge.

Required GitHub repo secrets:

| Secret                     | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| `SOURCEGRAPH_URL`          | Sourcegraph instance URL                           |
| `SRC_ACCESS_TOKEN`         | Sourcegraph access token                           |
| `CLAUDE_OAUTH_CREDENTIALS` | Claude credentials JSON (MCP path only)            |
| `SLACK_WEBHOOK_URL`        | Slack incoming webhook for scheduled runs          |

See [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) §4 for secret rotation.

## Canary invariant

The first entry in `config/invariants.json` (id prefix `canary-*`) is a synthetic rule
that is **expected to fail**. It searches for something known to exist in any
open-source repo; if it ever passes, Sourcegraph search is broken and the run
is untrustworthy. `ci-trigger.ts` renders canary failures as "expected" in PR
comments and excludes them from the failure gate.

## Repository layout

```
src/
  index.ts                        # entrypoint, mode dispatch (cli | ci), pre-flight
  invariant-engine.ts             # rule loader + per-invariant verification loop
  sourcegraph-client.ts           # SourcegraphGraphQLClient + SourcegraphMCPClient
  ci-trigger.ts                   # GitHub context detection, PR comment formatting, exit code policy
scripts/
  verify-invariants.sh            # CI-side runner
  post-github-comment.sh          # idempotent PR comment upsert
  post-slack.sh                   # Slack webhook payload
tests/
  ci-trigger.test.ts              # Vitest unit tests
  e2e-verify.sh                   # end-to-end against live Sourcegraph
config/
  invariants.json                 # rule definitions (max 20, enforced by schema)
  invariants.schema.json          # JSON Schema for invariants.json
  mcp-config.json                 # Sourcegraph MCP server config
docs/
  RUNBOOK.md                      # operator guide: triage, rotation, emergency disable
  AGENTS.md                       # contributor workflow (beads, session completion)
  prd_ci_setup.md                 # original PRD for the CI pipeline
CLAUDE.md                         # agent instructions + output contract
```

## Reference architecture

This repo doubles as a worked example of the pattern:

> **external trigger → agent with MCP tools → structured JSON verdict → idempotent notification**

Components that transfer cleanly to adjacent use cases (e.g. `webhook → DeepSearch MCP → report`):

- **Strict JSON output contract** (`CLAUDE.md` §Output Contract) — no markdown
  fences, no prose, easy to consume from shell/CI.
- **Canary probe** — synthetic check that must fire, so broken tool
  connectivity is detectable instead of silent.
- **Trust-boundary file pinning** — PR-author-controlled files are read from
  the base branch, not the PR branch.
- **Exit-code policy** — separate code for "rule violation" vs "infrastructure
  failure" so CI can react differently.
- **Idempotent comment upsert** — HTML-comment marker locates the prior bot
  comment and patches it in place.
- **Secret masking** — `::add-mask::` on every secret echoed in Actions.

## Documentation map

- [`CLAUDE.md`](./CLAUDE.md) — agent instructions, invariant schema, JSON output contract
- [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) — operator guide: triage, secret rotation, emergency disable, failure modes
- [`docs/AGENTS.md`](./docs/AGENTS.md) — contributor workflow (beads, session completion)
- [`docs/prd_ci_setup.md`](./docs/prd_ci_setup.md) — original PRD for the CI pipeline

## License

[MIT](./LICENSE).
