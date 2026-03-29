# Crossbreed Notes: A-Dominant Matrix Isolation + Rich Slack

## Strategy

A-dominant hybrid: Parent A's zero-code GitHub Action + CLAUDE.md approach is the backbone.
Parent B's per-invariant isolation is achieved via GitHub Actions **matrix strategy** instead of bash orchestrator.
Parent B's rich Slack output is kept as the ONE allowed script.
Parent C's Zod validation concept is realized as a JSON Schema file.

## What Was Taken From Each Parent

### Parent A (Pure GitHub Action) — Dominant

| Artifact                         | Status      | Notes                                                                                                |
| -------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `CLAUDE.md` agent instructions   | Enhanced    | Added per-invariant focus ("you are verifying a single invariant") and Output Contract section       |
| `.github/invariants.yml`         | Taken as-is | Declarative invariant config with A's concise assertion keys (`must_contain:` vs `type: + pattern:`) |
| `.github/claude-mcp-config.json` | Taken as-is | MCP server configuration for Sourcegraph                                                             |
| Zero-code philosophy             | Preserved   | No TypeScript, no custom orchestrator — YAML + CLAUDE.md + one bash script                           |
| `claude -p --bare` invocation    | Preserved   | Direct CLI call with MCP config and tool allowlist                                                   |

### Parent B (CLI + Hooks) — Grafted

| Artifact                         | Status            | Notes                                                                                                                                                            |
| -------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-invariant isolation          | **Reimplemented** | B used a bash for-loop; crossbreed uses GitHub Actions `matrix` strategy — each invariant is a separate **job** with its own runner, timeout, and error boundary |
| `scripts/post-slack.sh`          | Enhanced          | Added `SLACK_CHANNEL` override, description lines in pass output, jq prerequisite check                                                                          |
| JSON report contract             | Preserved         | `{timestamp, summary, results[]}` format is the integration spine between verify jobs and report job                                                             |
| `scripts/post-github-comment.sh` | **Dropped**       | PR comment logic inlined in workflow report step — no need for a separate script                                                                                 |
| `scripts/verify-invariants.sh`   | **Dropped**       | The matrix strategy IS the orchestrator — no bash loop needed                                                                                                    |

### Parent C (Agent SDK Service) — Grafted

| Artifact                           | Status        | Notes                                                                                                           |
| ---------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------- | ----------------------- |
| Zod schema for config              | Reimplemented | As `.github/invariants.schema.json` (JSON Schema draft 2020-12) — validates same constraints without TypeScript |
| Assertion type enum                | Absorbed      | `must_contain                                                                                                   | must_not_contain | must_not_exist`codified via`oneOf` in schema |
| Severity enum                      | Absorbed      | `critical                                                                                                       | high             | medium                                       | low` codified in schema |
| SourcegraphClient, SlackNotifier   | **Dropped**   | Over-engineered for this use case; bash + MCP are sufficient                                                    |
| 3 operational modes                | **Dropped**   | CI-only via workflows; server mode deferred to future agent                                                     |
| Dockerfile, package.json, tsconfig | **Dropped**   | Zero dependencies is a feature                                                                                  |

## Key Innovation: Matrix as Orchestrator

The central insight: GitHub Actions `matrix` strategy replaces B's bash orchestrator entirely.

**Before (B):** `verify-invariants.sh` loops over invariants sequentially, calling `claude -p` once per invariant.

**After (crossbreed):**

1. `setup` job reads `invariants.yml`, emits `{"include": [{"id": "auth-init-required"}, ...]}` as matrix JSON
2. `verify` job runs in parallel across all invariants — each gets its own runner, 10-minute timeout, and artifact upload
3. `report` job downloads all artifacts, assembles the JSON report, posts to GitHub PR or Slack

Benefits:

- **True parallelism**: invariants verify concurrently across runners (B was sequential)
- **Native isolation**: a crashed/hung invariant doesn't block others
- **GitHub-native retry**: failed matrix jobs can be retried individually
- **No custom code**: the "orchestrator" is YAML workflow syntax

## Integration Challenges

1. **Matrix data passing**: GitHub Actions matrix requires a flat JSON array. Invariant objects have nested fields (search.pattern, assertion.must_contain). Solved by passing only `{"id": "..."}` in the matrix, then using `yq` in each job to extract the full invariant by ID.

2. **Assertion key detection**: A's YAML uses assertion type as the key (`must_contain: "pattern"`) while B's script expected explicit `type` and `pattern` fields. Each verify job detects the key via `jq -e '.assertion.must_not_exist'` fallback chain.

3. **Report assembly from artifacts**: B's bash loop accumulated results in a variable. The matrix approach uploads per-invariant JSON as artifacts, then the report job downloads and merges them. Required inventing the `results/result-*/result.json` glob pattern.

4. **PR comment without a script**: B had `post-github-comment.sh` (98 lines). Crossbreed inlines the markdown construction in the workflow using `jq -r '@base64'` iteration — denser but eliminates a file.

## New Connective Tissue

1. **Setup job**: New glue that converts `invariants.yml` to matrix JSON — bridges A's config format with GitHub Actions matrix.

2. **Artifact-based result passing**: New pattern replacing B's in-memory JSON accumulation. Each verify job uploads `result.json`; report job downloads all via `pattern: result-*`.

3. **Inline prompt construction**: Each matrix job builds a prompt from the YAML fields, telling Claude to "follow CLAUDE.md instructions." This bridges A's CLAUDE.md (HOW to verify) with B's per-invariant prompt (WHAT to verify).

4. **Schema validation step**: Optional `ajv-cli` validation via npx in the setup job — non-blocking, warns on failure.

## What Was Lost

### From Parent A

- **Single-job simplicity**: A had one job. Crossbreed has 3 (setup → verify[N] → report). Trade-off: gained isolation and parallelism.

### From Parent B

- **Composable stdin/stdout pipeline**: `verify | post-slack` is elegant. The matrix approach requires artifact-based passing instead. Only `post-slack.sh` retains the pipe pattern.
- **Local CLI usage**: B's scripts worked locally with `./scripts/verify-invariants.sh | ./scripts/post-slack.sh`. Matrix approach is CI-native. Local testing requires running the workflow or using `act`.

### From Parent C

- **Reusable TypeScript modules**: SourcegraphClient and SlackNotifier were designed for future agents. If needed, extract from the `prototype: agent-sdk-service` commit.
- **Server mode / Slack bot**: The always-on Slack bot with threaded replies and `@mention` triggers. Deferred.
- **Type safety**: No runtime types. JSON Schema validates config; CLAUDE.md validates agent output shape.

## Seam Locations

| Seam               | Where                                   | What connects                               |
| ------------------ | --------------------------------------- | ------------------------------------------- |
| YAML → Matrix      | `setup` job → `$GITHUB_OUTPUT`          | A's config format → GitHub Actions matrix   |
| Matrix → Prompt    | `verify` job, "Build prompt" step       | Matrix ID → yq extraction → Claude prompt   |
| Prompt → CLAUDE.md | `verify` job, "Verify" step             | Per-invariant data → CLAUDE.md instructions |
| Claude → Artifact  | `verify` job, grep + jq → `result.json` | Agent output → structured JSON              |
| Artifacts → Report | `report` job, glob download             | Per-invariant results → merged report.json  |
| Report → Slack     | `report` job → `post-slack.sh`          | JSON report → Slack Block Kit               |
| Report → PR        | `report` job, inline gh CLI             | JSON report → GitHub PR comment             |

## Self-Assessment

- **Coherence**: 4/5 — Feels like a natural GitHub-native design. The matrix strategy is the right abstraction for per-invariant isolation in CI. CLAUDE.md integration is clean. Only gap: some prompt-building logic is duplicated between PR and scheduled workflows.

- **Estimated effort to production-ready**: 1-2 days
  - Test with real Sourcegraph instance
  - Verify CLAUDE.md auto-discovery works with `claude -p --bare`
  - Tune `--max-turns` per invariant complexity
  - Consider extracting shared workflow logic into a reusable workflow

## File Inventory

| File                                              | Lines    | Origin                           |
| ------------------------------------------------- | -------- | -------------------------------- |
| `.github/invariants.yml`                          | 42       | A                                |
| `.github/invariants.schema.json`                  | 72       | C (concept) → JSON Schema        |
| `.github/claude-mcp-config.json`                  | 12       | A/B                              |
| `.github/workflows/invariant-check-pr.yml`        | 168      | A (base) + B (isolation)         |
| `.github/workflows/invariant-check-scheduled.yml` | 139      | A (base) + B (isolation + Slack) |
| `CLAUDE.md`                                       | 65       | A (enhanced)                     |
| `scripts/post-slack.sh`                           | 96       | B (enhanced)                     |
| `CROSSBREED_NOTES.md`                             | ~120     | New                              |
| **Total (excl. notes)**                           | **~594** |                                  |
