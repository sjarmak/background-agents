# Prototype Notes — Cross-Repo Invariant Verifier (CLI-Hooks Strategy)

## Approach Summary

Unix-pipe style: shell scripts + `claude -p --bare` CLI with Sourcegraph MCP. No frameworks, no Docker, no npm dependencies beyond the Claude CLI itself. Everything composes via stdin/stdout.

**Pipeline:** `invariants.yaml` → `verify-invariants.sh` → JSON report → `post-slack.sh` / `post-github-comment.sh`

## Key Design Decisions

| Decision                                | Why                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **YAML config, not code**               | Engineers declare invariants without writing verification logic. Adding a new invariant is a 10-line YAML block.                                                                                      |
| **One Claude call per invariant**       | Isolation — a flaky invariant can't poison others. Each call gets its own max-turns budget and error handling. Trade-off: more API calls, but cleaner failure modes.                                  |
| **JSON intermediate format**            | The report is the contract between verify and post scripts. Any consumer (Slack, GitHub, PagerDuty, Datadog) just needs to read JSON.                                                                 |
| **`yq` + `jq` for parsing**             | Avoids Python/Node runtime dependencies. These are standard CI tools. `yq` reads the YAML config; `jq` builds and transforms JSON.                                                                    |
| **Structured prompt → JSON output**     | Claude is instructed to return ONLY JSON. The script extracts it with `grep -o '{.*}'` — fragile but sufficient for a prototype. Production would use `--output-format json` or a more robust parser. |
| **Separate PR and scheduled workflows** | Different triggers need different outputs (PR comment vs Slack). Sharing the same verify script keeps logic DRY.                                                                                      |
| **`--allowedTools` whitelist**          | Safety rail — Claude can only use Sourcegraph search tools, not write files or run commands.                                                                                                          |

## What Works

- **`invariants.yaml`** — fully defined, realistic examples covering 4 invariant types
- **`verify-invariants.sh`** — complete orchestrator with arg parsing, prerequisite checks, per-invariant Claude calls, JSON report assembly, and proper exit codes
- **`post-slack.sh`** — formats violations into Slack blocks with severity coloring, truncates long lists
- **`post-github-comment.sh`** — renders markdown table + violation details with source links
- **Both GitHub Actions workflows** — PR trigger with path filters, scheduled weekly cron, artifact upload
- **`mcp-config.json`** — real Sourcegraph MCP server config with env var substitution

## What's Stubbed / Incomplete

- **No actual Sourcegraph instance to test against** — the Claude calls are real CLI invocations, but we can't verify the MCP round-trip works end-to-end without a Sourcegraph deployment
- **JSON extraction from Claude output is fragile** — `grep -o '{.*}'` will break if Claude returns multi-line JSON or includes JSON in explanations. Production needs structured output parsing
- **No caching** — each run re-checks every invariant from scratch. A production version could cache Sourcegraph results and only re-verify changed repos
- **No retry logic** — if a Claude call fails mid-way (rate limit, timeout), the invariant is marked as "error" with no retry
- **Slack payload uses blocks API** — tested structure but not against a real webhook
- **No CLAUDE.md with verifier instructions** — the existing workflow references it, but we inline the prompt directly instead

## Trade-offs

1. **Sequential invariant checks vs parallel** — Chose sequential for simplicity. Could parallelize with `&` + `wait`, but error handling gets messy in bash. For 4-10 invariants at ~30s each, sequential is fine.

2. **Claude CLI per invariant vs single mega-prompt** — Per-invariant is more API calls but: isolated failures, clearer debugging, fits within max-turns budget. A mega-prompt risks running out of turns on complex invariants.

3. **Bash vs Python** — Bash is more portable (no runtime to install) but harder to maintain at scale. If this grows past ~10 invariants or needs conditional logic, rewrite the orchestrator in Python.

4. **`yq` dependency** — Not always pre-installed. Could parse YAML with `grep`/`awk` but that's brittler than the dependency.

## File Inventory

```
invariants.yaml                                  — invariant definitions (~50 lines)
mcp-config.json                                  — Sourcegraph MCP config (~10 lines)
scripts/verify-invariants.sh                     — main orchestrator (~160 lines)
scripts/post-slack.sh                            — Slack poster (~90 lines)
scripts/post-github-comment.sh                   — GitHub PR commenter (~100 lines)
.github/workflows/invariant-check-pr.yml         — PR trigger workflow (~55 lines)
.github/workflows/invariant-check-scheduled.yml  — weekly cron workflow (~50 lines)
```

**Total: ~515 lines across 7 files**

## Self-Assessed Quality: 4/5

Strong prototype that demonstrates the full pipeline. Real bash with real error handling, real CLI flags, real webhook payloads. The main gap is end-to-end testing against a live Sourcegraph instance.

## Estimated Effort to Production-Ready: 2-3 days

- **Day 1:** Set up Sourcegraph test instance, verify MCP round-trip, fix JSON parsing edge cases
- **Day 2:** Add retry logic, parallel execution, caching layer, and CLAUDE.md instructions
- **Day 3:** Integration test suite, Slack payload testing, documentation, team onboarding
