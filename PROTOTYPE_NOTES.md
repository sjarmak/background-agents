# Prototype Notes: Cross-Repo Invariant Verifier

## Approach Summary

TypeScript service using the Claude Agent SDK (`@anthropic-ai/claude-code`) with Sourcegraph MCP configured programmatically. The agent verifies cross-repo invariants — rules like "every repo importing auth-lib must call auth.init()" — by searching across all repos via Sourcegraph and checking assertions against the results.

Three operational modes:
- **CLI**: One-shot verification, prints results, exits with appropriate code
- **CI**: GitHub Actions integration, posts violations as PR comments
- **Server**: Long-lived Slack bot with scheduled weekly scans

## Key Design Decisions

1. **JSON invariant config with Zod validation** — Chose JSON over YAML (despite existing `.github/invariants.yml`) because JSON schema validation is native and Zod provides runtime type safety. The YAML version can coexist for human authoring; a converter is trivial.

2. **Claude Agent SDK as Sourcegraph interface** — Rather than calling Sourcegraph REST API directly, we invoke Claude Code with Sourcegraph MCP tools whitelisted. This means the agent can reason about search results, handle pagination, and adapt queries — but adds latency and cost vs direct API calls.

3. **Three assertion types** — `must_contain`, `must_not_contain`, `must_not_exist` cover the invariant patterns from the PRD. File-scope vs repo-scope assertions handle both "every file doing X must also do Y" and "every repo doing X must also do Y".

4. **Reusable modules** — `SourcegraphClient` and `SlackNotifier` are designed with clean interfaces for direct reuse by Week 2-3 agents. No invariant-specific logic leaks into them.

5. **Safety rails** — `maxTurns: 12`, explicit `allowedTools` whitelist (only Sourcegraph MCP tools), and `--bare` mode via the Agent SDK options.

## What Works vs What's Stubbed

### Works (structurally complete)
- Invariant config loading and Zod validation
- Three-mode entry point (CLI/CI/Server) with env var config
- InvariantEngine orchestration: search → assertion → violations
- PR comment formatting with severity badges
- GitHub Actions workflow with PR + schedule triggers
- Slack message formatting with blocks and threaded violations
- Slack @mention trigger handler

### Stubbed/Incomplete
- `SourcegraphClient.runAgent()` — real Agent SDK `query()` call is wired up, but JSON parsing of agent responses is fragile (regex extraction). Production would need structured output or tool-result parsing.
- Slack scheduled scan in CI — the workflow just echoes; a real implementation would run a separate server-mode invocation or use a GitHub Action for Slack posting.
- No retry/backoff on Sourcegraph or Slack API failures.
- No caching of search results across invariants (could deduplicate Sourcegraph queries).
- `@anthropic-ai/claude-code` import assumes the SDK exports `query` — actual API may differ slightly.

## Trade-offs

| Decision | Pro | Con |
|----------|-----|-----|
| Agent SDK for Sourcegraph | Adaptive queries, reasoning over results | Slower, costlier, less deterministic than direct API |
| Single process, three modes | Simple deployment, shared code | Server mode blocks on scan; would need worker threads for production |
| Zod schema at runtime | Type-safe, good error messages | Extra dependency; could use JSON Schema directly |
| Severity-based exit codes | CI fails on critical/high only | Teams might want configurable threshold |

## Self-Assessed Quality

**3/5** — Architecture is clear and the module boundaries are clean. The core verification loop is realistic. The Agent SDK integration is the weakest part — it works conceptually but the JSON parsing of free-form agent responses would need hardening. Good enough to validate the architecture and demonstrate the approach.

## Estimated Effort to Production-Ready

**3-5 days** for a single engineer:
- Day 1: Harden Agent SDK integration (structured outputs, error handling, retries)
- Day 2: Real Slack bot testing, socket mode, thread management
- Day 3: CI integration testing with actual Sourcegraph instance
- Day 4: Add caching, parallel invariant checking, config hot-reload
- Day 5: Monitoring, alerting, runbook, deploy to production
