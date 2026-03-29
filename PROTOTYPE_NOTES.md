# Prototype Notes: Cross-Repo Invariant Verifier

## Approach Summary

Pure GitHub Action prototype — zero custom code. Everything is declarative YAML/JSON config + Claude Code Action with Sourcegraph MCP. Engineers declare invariants in `.github/invariants.yml`, and the agent verifies them across all repositories using Sourcegraph's cross-repo search.

## Key Design Decisions

**1. Claude Code Action as the engine, not custom code**
The `anthropics/claude-code-action@v1` does the heavy lifting. The invariant config is passed as a prompt, and `CLAUDE.md` teaches the agent how to interpret it. This means zero runtime code to maintain — just YAML config and natural language instructions.

**2. Invariant schema is deliberately simple**
Each invariant is: search pattern + assertion + message. The agent interprets this flexibly rather than requiring a rigid DSL. This trades precision for speed-to-ship and handles edge cases through LLM reasoning rather than code.

**3. Two separate workflows instead of one parameterized workflow**
PR-triggered and scheduled scans have different concerns (comment on PR vs post to Slack, single-repo focus vs full scan). Separate files are clearer than conditional logic.

**4. Allowed tools whitelist**
Only `keyword_search`, `find_references`, and `read_file` — the agent cannot modify code, create PRs, or access other MCP tools. Read-only by design.

**5. MCP config uses environment variable substitution**
Sourcegraph credentials come from GitHub Secrets, interpolated at runtime via `env` block in the MCP config. No secrets in source.

## What Works

- Invariant YAML schema is complete and supports 4 assertion types (must_contain, must_not_contain, must_not_exist at repo/file scope)
- PR workflow triggers on relevant file changes and posts results as PR comments
- Scheduled workflow runs weekly with Slack notification
- CLAUDE.md provides clear verification algorithm the agent can follow
- Safety rails: max_turns=15, allowed_tools whitelist, timeout-minutes on jobs
- Example invariants cover real-world patterns (auth init, dual DB clients, deprecated packages, gRPC timeouts)

## What's Stubbed/Incomplete

- **MCP server package**: Uses `@nicepkg/sourcegraph-mcp` — needs verification that this is the right package and supports the expected tool names. The official Sourcegraph MCP server may use different tool names.
- **Slack notification**: Posts a link to the Actions run rather than the full report inline. Getting Claude's output into the Slack payload requires capturing `claude-code-action` output, which may need the action's `output` parameter (not yet documented).
- **No result caching**: Each run re-scans everything. A production version could cache Sourcegraph results or track which invariants changed.
- **No CODEOWNERS integration**: The weekly report mentions grouping by team/codeowner but the agent has no access to CODEOWNERS files across repos without additional search steps.

## Trade-offs

| Decision                        | Pro                          | Con                                          |
| ------------------------------- | ---------------------------- | -------------------------------------------- |
| LLM interprets invariants       | Flexible, handles edge cases | Non-deterministic, may miss violations       |
| No custom code                  | Nothing to maintain          | Less control over output format              |
| Single MCP config               | Simple                       | Can't scope Sourcegraph access per invariant |
| Separate PR/scheduled workflows | Clear separation             | Some duplication in config reading           |

## Self-Assessed Quality

**3.5/5** — Complete enough to demonstrate the concept and could work with a real Sourcegraph instance. Main gaps are MCP package verification and Slack report richness. The invariant schema is production-quality.

## Estimated Effort to Production-Ready

**2-3 days:**

- Verify/fix MCP server package and tool names (~2h)
- Test against real Sourcegraph instance and tune prompts (~4h)
- Capture and format Claude output for rich Slack messages (~4h)
- Add retry logic and error handling for MCP failures (~2h)
- Write documentation and onboarding guide (~2h)
- Test with real invariants across org repos (~4h)
