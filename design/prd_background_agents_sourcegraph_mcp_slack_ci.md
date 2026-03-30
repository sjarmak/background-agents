# PRD: Background Agents with Sourcegraph MCP (Slack & CI Triggers)

## Problem Statement

Development teams need AI-powered code intelligence agents that can be triggered on-demand (via Slack) or automatically (via CI/GitHub Actions) to answer codebase questions, review PRs with cross-repo context, investigate bugs, and perform automated code analysis. These agents must have deep codebase understanding beyond the single repo they operate in — requiring integration with Sourcegraph's MCP server for cross-repository search, symbol navigation, and architectural reasoning.

Currently, Claude Code operates interactively in terminals/IDEs. Background and remote trigger capabilities exist but are not yet wired together with Sourcegraph MCP into a cohesive system that serves an engineering team via their existing communication (Slack) and development (GitHub) workflows.

## Goals & Non-Goals

### Goals

- Enable developers to trigger Claude Code agents via `@agent` mentions in Slack channels/threads
- Enable automatic agent invocation via GitHub Actions (PR opened, issue created, `@claude` comment, scheduled cron)
- Equip all agent invocations with Sourcegraph MCP for cross-repo code search, symbol navigation, and architectural reasoning
- Provide a single shared MCP configuration that works across all trigger mechanisms
- Maintain security boundaries: read-only for Slack, scoped write for CI
- Keep operational costs predictable with explicit limits and monitoring

### Non-Goals

- Building a custom Slack bot framework from scratch (prefer official integration or lightweight bridges)
- Multi-repo PR creation (Sourcegraph can search across repos, but PRs target single repos)
- Replacing interactive Claude Code usage — this complements it
- Real-time streaming responses in Slack (async web session links are acceptable)
- Custom Sourcegraph MCP server development (use official HTTP endpoint or community npm package)

## Implementation Roadmap (from Convergence Debate)

Three independent advocates (Quick Wins, Maximum Differentiation, Platform Foundation) debated sequencing and converged on this plan. See `convergence_report.md` for full debate transcript.

### Week 1: #25 Cross-Repo Invariant Verifier (consensus first-build)

- Engineers declare cross-repo invariants in config ("every service importing auth-lib MUST call auth.init()")
- Agent uses Sourcegraph `find_references` + `keyword_search` across ALL repos to verify
- Runs on every CI build + scheduled weekly scan
- Posts violations to PR comments (CI trigger) or Slack (scheduled)
- **Infrastructure built alongside**: shared `SourcegraphClient`, `SlackNotifier`, `CITrigger`, `CodeOwnersResolver` modules with clean boundaries

### Week 2: #3 Cross-Repo Semantic Merge Conflict Predictor

- On PR open, finds OTHER open PRs across all repos touching the same symbols
- Predicts semantic (not textual) merge conflicts before they happen
- "This PR in repo-A will conflict with that PR in repo-B" — a sentence no other tool can say
- Reuses Week 1 shared modules; refactor based on real friction from having 2 consumers

### Week 3: #1 Dependency Impact Oracle OR #10 RFC Impact Simulator

- **#1 if optimizing for daily utility**: On breaking change push, map blast radius across all downstream repos
- **#10 if optimizing for demo wow-factor**: Before coding, simulate RFC impact across real codebase
- Third consumer of shared modules validates the emerging platform layer

### Week 4: Evaluate and decide

- Assess whether Knowledge Graph Materializer (#30) would accelerate agents #4-10
- Review actual Sourcegraph query patterns from 3 built agents
- Build #9 (Incident Root Cause Tracer) or begin #30 based on evidence

### Selection Filter (from debate)

Every agent must pass the differentiation test: "Could Copilot/Cursor approximate this with single-repo access?" If yes, don't build it.

### Month 2 Candidates (queued)

- #22 Code Clone Divergence Tracker (security: finds unpatched bugs in forked code)
- #20 Architecture Fitness Function Runner (continuous architectural test suite)
- #9 Incident Root Cause Tracer (code archaeology for incidents)
- #2 Living Architecture Narrator (weekly architectural drift reports)

## Infrastructure Requirements

### Must-Have

- **GitHub Actions integration**: `anthropics/claude-code-action@v1` workflow triggered by `issue_comment`, `pull_request`, and `repository_dispatch` events, with Sourcegraph MCP injected via `--mcp-config`
- **Sourcegraph MCP configuration**: Shared config file (`.github/claude-mcp-config.json` or `.mcp.json`) defining the Sourcegraph MCP server with auth via environment variables/secrets
- **Safety rails**: `--max-turns 10-15`, `--allowedTools` whitelist (explicitly listing permitted Sourcegraph tools), `--bare` mode for all CI invocations
- **Secrets management**: Anthropic API key, Sourcegraph token, and Slack credentials stored in GitHub Actions secrets and deployment environment (never hardcoded)
- **Basic CLAUDE.md instructions**: Teach the agent how to use Sourcegraph tools effectively ("start narrow, expand only if needed")
- **Shared modules with clean boundaries**: `SourcegraphClient`, `SlackNotifier`, `CITrigger`, `CodeOwnersResolver` — built with #25, reused by all subsequent agents

### Should-Have

- **Slack trigger**: Official Claude Code Slack integration configured with Sourcegraph MCP, or lightweight custom bot (Bolt framework) for custom routing
- **Slack-to-GitHub bridge**: `repository_dispatch` event from Slack bot for write operations (bug fixes, PR creation), keeping Slack bot stateless
- **Cost monitoring**: Token usage tracking per invocation, daily/weekly cost reports, alerting on anomalous usage
- **PreToolUse hooks**: Block Sourcegraph `read_file` on sensitive paths (`*.env`, `**/secrets/**`), enforce `repo:` scope on searches
- **Permission tiers**: Read-only for Slack, read+write on PR branch for CI, full write only for approved automation workflows

### Nice-to-Have

- **Starter prompts cheat sheet**: Pinned Slack message with copy-pasteable example triggers
- **Scheduled agents**: Cron-triggered workflows for periodic codebase health reports, dependency vulnerability scans, documentation freshness checks
- **Quality dashboard**: Success/failure rates, user satisfaction, output quality metrics
- **Multi-turn conversation support**: Session resumption for Slack threads (via Agent SDK session IDs)
- **Sourcegraph `deepsearch` for architectural questions**: Dedicated workflow for complex cross-repo architectural analysis

## Design Considerations

### Key Tensions and Trade-offs

1. **Official Slack integration vs. custom bot**: The official Claude Code Slack app is production-ready and full-featured (thread context, progress updates, PR creation). However, it may not support custom MCP server configuration at the organizational level. A custom bot gives full control but requires infrastructure. **Recommendation**: Start with the official integration; build custom only if MCP config proves impossible.

2. **Broad vs. scoped Sourcegraph access**: Unrestricted search maximizes agent capability but risks context window saturation and cost overruns. Enforced `repo:` scoping reduces value for cross-repo questions. **Recommendation**: Default to scoped queries via hooks, with an explicit "deep search" mode that users can opt into.

3. **Read-only vs. read-write for Slack agents**: Read-only is safer but limits usefulness (can't create PRs from Slack). **Recommendation**: Read-only by default, with write operations routed through GitHub Actions via `repository_dispatch`.

4. **stdio vs. HTTP MCP transport**: The community `sourcegraph-mcp-server` npm package uses stdio (simpler for ephemeral CI). The official Sourcegraph `/.api/mcp` endpoint uses HTTP (no npm dependency, but requires HTTP transport support). **Recommendation**: Use HTTP transport (`--transport http`) for production stability; fall back to stdio npm package for rapid prototyping.

5. **Trust model in Slack channels**: Any channel participant can influence agent behavior via their messages. **Recommendation**: Restrict agent to dedicated channels or DMs for sensitive operations; use public channels only for read-only queries.

## Architecture Overview

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Slack      │────▶│  Slack Bot /      │────▶│  Claude Code     │
│   @agent     │     │  Official App     │     │  (Agent SDK)     │
└─────────────┘     └──────────────────┘     │  + Sourcegraph   │
                           │                  │    MCP            │
                           │ (write ops)      └────────┬──────────┘
                           ▼                           │
                    ┌──────────────┐                   │ results
                    │  GitHub API   │                   ▼
                    │  repository_  │           ┌──────────────┐
                    │  dispatch     │           │  Slack Thread │
                    └──────┬───────┘           │  / PR Comment │
                           │                   └──────────────┘
                           ▼
┌─────────────┐     ┌──────────────────┐
│  GitHub      │────▶│  GitHub Actions   │────▶ Claude Code Action
│  Events      │     │  Workflow         │     + Sourcegraph MCP
│  (PR, Issue, │     └──────────────────┘     + --bare --max-turns
│   Comment,   │
│   Cron)      │
└─────────────┘
```

## Open Questions

1. **Sourcegraph MCP rate limits**: Undocumented. Must test empirically before scaling beyond pilot.
2. **Data residency**: Code content from Sourcegraph flows through Claude API. Legal/compliance review needed for regulated teams.
3. **Official Slack app MCP configuration**: Can the official Claude Code Slack integration be configured with custom MCP servers at the org level?
4. **Cost predictability**: No per-session cost cap exists. Need to validate that `--max-turns` provides sufficient cost control.
5. **Community MCP server reliability**: The `sourcegraph-mcp-server` npm package is community-maintained. Evaluate stability vs. the official HTTP endpoint.

## Research Provenance

This PRD was synthesized from 4 independent research perspectives:

| Lens                        | Key Contribution                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Prior Art & Ecosystem**   | Mapped 3 Slack bot architectures, validated GitHub Action MCP support, identified Slack-to-Issue bridge pattern      |
| **First-Principles Design** | Produced concrete architecture with two-tier (Slack reads / GH Actions writes), identified `--bare` mode criticality |
| **Developer Experience**    | Discovered official Slack integration is already production-ready, defined top 10 use cases, onboarding strategy     |
| **Failure Modes & Risks**   | Identified Slack trust model weakness, no per-session cost cap, context saturation risk from Sourcegraph tools       |

**Key convergence**: All 4 agents agreed on `claude-code-action@v1` + Sourcegraph MCP config as the CI path, and `--max-turns` + `--allowedTools` as essential safety rails.

**Key divergence**: Whether to use the official Slack integration (simpler) vs. custom bot (more control), and how aggressively to scope Sourcegraph queries (safety vs. capability).
