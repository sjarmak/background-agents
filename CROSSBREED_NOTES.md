# Crossbreed Notes: B-Dominant Scripts + CLAUDE.md + Typed Config

## Strategy

B-dominant hybrid: Parent B's bash scripts and JSON report contract form the backbone.
Parent A's CLAUDE.md agent instruction pattern replaces inline prompts.
Parent C's Zod validation concept is realized as a JSON Schema file.

## What Was Taken From Each Parent

### Parent B (CLI + Hooks) — Dominant

| Artifact                                          | Status      | Notes                                                                |
| ------------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| `scripts/verify-invariants.sh`                    | Adapted     | Core loop preserved; inline prompt replaced with CLAUDE.md reference |
| `scripts/post-slack.sh`                           | Taken as-is | Composable stdin/stdout contract unchanged                           |
| `scripts/post-github-comment.sh`                  | Taken as-is | Composable stdin/stdout contract unchanged                           |
| `invariants.yaml`                                 | Taken as-is | Added schema reference in header comment                             |
| `mcp-config.json`                                 | Taken as-is | Identical across parents                                             |
| `.github/workflows/invariant-check-pr.yml`        | Adapted     | Added schema validation step                                         |
| `.github/workflows/invariant-check-scheduled.yml` | Taken as-is | No changes needed                                                    |
| JSON report contract                              | Preserved   | `{timestamp, summary, results[]}` format is the integration spine    |
| Per-invariant isolation                           | Preserved   | One `claude -p` call per invariant — key reliability feature         |

### Parent A (Pure GitHub Action) — Grafted

| Artifact                       | Status   | Notes                                                                                                                                                                     |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md` agent instructions | Adapted  | Expanded from A's version: added Output Contract section for JSON responses, added `assertion.type` field docs to match B's YAML format, kept verification steps and tips |
| Declarative philosophy         | Absorbed | The idea that the agent learns from CLAUDE.md rather than from inline prompts                                                                                             |

### Parent C (Agent SDK Service) — Grafted

| Artifact                                          | Status        | Notes                                                                                                            |
| ------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------- | ----------------------- |
| Zod schema for invariant config                   | Reimplemented | As `invariants.schema.json` (JSON Schema draft 2020-12) — validates same structure without TypeScript dependency |
| Assertion type enum                               | Absorbed      | `must_contain                                                                                                    | must_not_contain | must_not_exist` codified in schema |
| Severity enum                                     | Absorbed      | `critical                                                                                                        | high             | medium                             | low` codified in schema |
| SourcegraphClient, SlackNotifier, InvariantEngine | Dropped       | Over-engineered for this use case; bash scripts + MCP are sufficient                                             |
| 3 operational modes (CLI/CI/Server)               | Dropped       | CI and CLI covered by scripts; server mode deferred                                                              |
| Dockerfile, package.json, tsconfig                | Dropped       | Zero dependencies is a feature                                                                                   |

## Integration Challenges

1. **Prompt structure mismatch**: Parent A's CLAUDE.md assumed the agent reads invariants directly from YAML. Parent B feeds one invariant at a time via prompt. Resolution: CLAUDE.md teaches general verification logic and output contract; `verify-invariants.sh` constructs per-invariant prompts that say "follow CLAUDE.md instructions" with specific invariant data inlined.

2. **Assertion field naming**: Parent A uses `must_contain`/`must_not_contain` as direct keys on the assertion object. Parent B uses `type` + `pattern` fields. The hybrid follows B's explicit `type`/`pattern`/`scope` structure — it's more uniform and easier to validate with JSON Schema.

3. **Schema validation in CI**: Parent C used Zod at runtime in TypeScript. The hybrid uses `ajv-cli` via npx in the workflow — no install needed, fails gracefully if unavailable. Added as optional validation step, non-blocking in CI.

## New Connective Tissue

1. **Output Contract in CLAUDE.md**: Neither parent explicitly documented the JSON response format the agent must return. Added an "Output Contract" section to CLAUDE.md that specifies the exact `{status, violations}` shape. This bridges CLAUDE.md (from A) with the JSON extraction in verify-invariants.sh (from B).

2. **Schema reference in invariants.yaml header**: Added comment pointing to `invariants.schema.json` so contributors know validation exists.

3. **`-s` flag in verify-invariants.sh**: New flag for schema file path, enabling local validation before running expensive Claude calls.

## What Was Lost From Non-Dominant Parents

### From Parent A

- **Zero custom code**: We now have ~200 lines of bash. Trade-off: gained per-invariant isolation and composable output pipelines.
- **claude-code-action@v1 integration**: Replaced with direct `claude -p` CLI calls. The action abstraction wasn't needed since we control the prompt construction.

### From Parent C

- **Reusable TypeScript modules**: SourcegraphClient and SlackNotifier were designed for Week 2-3 agents. If future agents need them, they can be extracted from the prototype commit.
- **Server mode / Slack bot**: The always-on Slack bot with threaded replies. The webhook approach is simpler but less interactive.
- **Type safety**: Bash has no types. JSON Schema provides config validation but not runtime safety. Acceptable given the simple data flow.

## Seam Locations

| Seam                | Where                          | What connects                                    |
| ------------------- | ------------------------------ | ------------------------------------------------ |
| Prompt construction | `verify-invariants.sh:119-133` | B's per-invariant loop → A's CLAUDE.md reference |
| JSON extraction     | `verify-invariants.sh:139`     | Claude's response → B's report contract          |
| Schema validation   | `verify-invariants.sh:83-91`   | C's validation concept → B's config file         |
| CI validation step  | `invariant-check-pr.yml:33-38` | C's validation concept → B's workflow            |
| Output contract     | `CLAUDE.md:50-70`              | A's agent instructions → B's JSON parsing        |

## Self-Assessment

- **Coherence**: 4/5 — Feels like a natural evolution of B. The CLAUDE.md integration is clean. Schema validation is additive and non-disruptive. Only gap: the prompt says "follow CLAUDE.md" but claude CLI doesn't explicitly load CLAUDE.md as system context when run with `-p` — it relies on CLAUDE.md being in the repo root where claude auto-discovers it.

- **Estimated effort to production-ready**: 1-2 days
  - Test with real Sourcegraph instance
  - Verify CLAUDE.md auto-discovery works with `claude -p --bare`
  - Add retry logic for transient MCP failures (optional)
  - Tune `--max-turns` per invariant complexity
