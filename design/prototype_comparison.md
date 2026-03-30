# Prototype Comparison: Cross-Repo Invariant Verifier (#25)

## Strategy Summary Table

| Dimension                      | A: Pure GitHub Action            | B: CLI + Hooks                                | C: Agent SDK Service                            |
| ------------------------------ | -------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| **Files**                      | 6                                | 8                                             | 11                                              |
| **Lines**                      | 356                              | 582                                           | 1,242                                           |
| **Languages**                  | YAML + Markdown                  | Bash + YAML                                   | TypeScript + YAML + Docker                      |
| **Dependencies**               | None (just GH Actions)           | yq, jq, claude CLI, gh CLI                    | Node.js, claude-code SDK, @slack/bolt, zod      |
| **Invariant format**           | `.github/invariants.yml`         | `invariants.yaml`                             | `invariants.json` (Zod-validated)               |
| **Sourcegraph integration**    | Claude Code Action + MCP config  | `claude -p --bare --mcp-config` per invariant | Agent SDK `query()` with MCP config             |
| **Slack integration**          | Webhook step in workflow         | `curl` to webhook via `post-slack.sh`         | Slack Bolt bot (native, with @mention triggers) |
| **CI integration**             | `claude-code-action@v1` directly | Scripts called from workflow                  | Service invoked from workflow                   |
| **Operational modes**          | CI only                          | CI only                                       | CLI + CI + Server (3 modes)                     |
| **Self-assessed quality**      | 3.5/5                            | 4/5                                           | 3/5                                             |
| **Days to production**         | 2-3                              | 2-3                                           | 3-5                                             |
| **Reusability for agents #3+** | Low                              | Medium                                        | High                                            |

## Requirements Coverage

| Requirement                            |    A: GH Action     |    B: CLI Hooks     |             C: SDK Service             |
| -------------------------------------- | :-----------------: | :-----------------: | :------------------------------------: |
| Declarative invariant config           |         Yes         |         Yes         |                  Yes                   |
| Sourcegraph MCP for cross-repo search  |         Yes         |         Yes         |                  Yes                   |
| PR-triggered verification              |         Yes         |         Yes         |                  Yes                   |
| Scheduled weekly scan                  |         Yes         |         Yes         |                  Yes                   |
| Post violations to PR comments         |         Yes         |         Yes         |                  Yes                   |
| Post violations to Slack               | Partial (link only) |  Yes (rich blocks)  |  Yes (rich blocks + @mention trigger)  |
| Safety rails (max-turns, allowedTools) |         Yes         |         Yes         |                  Yes                   |
| Secrets management                     |  Yes (GH Secrets)   |  Yes (GH Secrets)   |             Yes (env vars)             |
| Shared modules for Week 2-3            |         No          |  Partial (scripts)  | Yes (SourcegraphClient, SlackNotifier) |
| CLAUDE.md agent instructions           |         Yes         | No (inline prompts) |           No (programmatic)            |

## Trade-off Analysis

### Simplicity vs Reusability

```
A: Pure GH Action ←————————————→ C: SDK Service
(simplest, least reusable)         (most complex, most reusable)
         B: CLI Hooks
         (middle ground)
```

### Time to Ship vs Long-term Velocity

- **A** ships fastest (hours) but each new agent is a fresh build
- **B** ships fast (hours) with moderate script reuse
- **C** takes days but agents #3-10 are faster because `SourcegraphClient` and `SlackNotifier` already exist

### Determinism vs Flexibility

- **A** relies on LLM to interpret invariant YAML — flexible but non-deterministic
- **B** has structured prompts per invariant with JSON output — more predictable
- **C** has Zod-validated config + typed assertions — most deterministic

## Best Ideas From Each Prototype

### From A (Pure GitHub Action)

- **CLAUDE.md as the agent instruction layer** — elegant. The agent's behavior is configured via natural language instructions, not code. This is the most "Claude Code native" approach and could be combined with any backend.
- **Zero-dependency philosophy** — nothing to install, nothing to break. If this is good enough, it's the right answer.

### From B (CLI + Hooks)

- **One Claude call per invariant** — brilliant isolation model. A flaky invariant can't poison others. Each gets its own max-turns budget. This should be adopted regardless of which approach wins.
- **JSON report as the universal contract** — the intermediate format between verify and output is clean. Any consumer (Slack, GitHub, PagerDuty, Datadog) just reads JSON.
- **Composable scripts via stdin/stdout** — `verify-invariants.sh | post-slack.sh` is dead simple to debug and extend.

### From C (Agent SDK Service)

- **`SourcegraphClient` and `SlackNotifier` as reusable modules** — exactly what the convergence debate called for. Clean interfaces, no invariant-specific logic leaked in.
- **Three operational modes (CLI/CI/Server)** — the only prototype that works as a Slack bot, not just a CI tool. This matters for the Slack trigger requirement.
- **Zod-validated invariant schema** — type-safe config with clear error messages at load time.

## Recommended Path Forward

### The "Best of All Worlds" Combination

**Start with B (CLI + Hooks) as the foundation, adopt A's CLAUDE.md pattern, and extract C's module architecture as agents accumulate.**

Concretely:

1. **Week 1 ship**: Use **B's architecture** (scripts + JSON contract + one-call-per-invariant) with **A's CLAUDE.md** for agent instructions. This gives us:
   - Fast to ship (hours, not days)
   - One Claude call per invariant (B's isolation model)
   - JSON report as universal output format (B)
   - CLAUDE.md teaching the agent Sourcegraph patterns (A)
   - Rich Slack output (B's post-slack.sh)
   - No framework dependencies

2. **Week 2 (when building #3 Merge Conflict Predictor)**: If we find ourselves duplicating Sourcegraph query patterns, extract **C's `SourcegraphClient` interface** into a shared TypeScript module. The convergence debate's "intentional extraction" principle — don't abstract until you have 2 consumers.

3. **Week 3+**: If Slack bot interactivity becomes important (not just webhook posting), adopt **C's Slack Bolt integration** as the Slack layer. The CLI scripts continue to work for CI.

### Why not just pick one?

- **A alone** can't do rich Slack output or per-invariant isolation
- **B alone** doesn't have the reusable module architecture for agents #3+
- **C alone** takes 3-5 days to production and has the weakest self-assessed quality (3/5)

The combination gives us B's speed and robustness, A's elegance, and C's architecture available when we need it.

## Per-Prototype Highlights

- **A (Pure GitHub Action)**: Most elegant — proved you can build a working invariant verifier with zero custom code. The CLAUDE.md-as-configuration pattern is the most "Claude Code native" insight and should be adopted regardless.

- **B (CLI + Hooks)**: Most production-ready — the one-call-per-invariant isolation, JSON intermediate format, and composable scripts make this the most debuggable and robust prototype. Highest self-assessed quality (4/5).

- **C (Agent SDK Service)**: Most forward-looking — the only prototype designed for reuse. `SourcegraphClient` and `SlackNotifier` are ready to be imported by Week 2-3 agents. The three-mode architecture (CLI/CI/Server) is the most operationally flexible.
