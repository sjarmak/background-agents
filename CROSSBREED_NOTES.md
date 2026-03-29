# Crossbreed Notes: C-Dominant + Slim + Isolated + CLAUDE.md

## Strategy

Start from Parent C's TypeScript module architecture, graft Parent B's
per-invariant isolation and JSON report contract, and Parent A's CLAUDE.md
agent instruction layer. Remove server mode (Slack Bolt bot) entirely.

## What Was Taken From Each Parent

### Parent C (agent-sdk-service) — Dominant

| Component                   | Action      | Rationale                                                            |
| --------------------------- | ----------- | -------------------------------------------------------------------- |
| `src/sourcegraph-client.ts` | Kept ~as-is | Reusable module for future agents; well-structured Agent SDK wrapper |
| `src/invariant-engine.ts`   | Modified    | Good Zod schema + assertion logic, but needed isolation pattern      |
| `src/ci-trigger.ts`         | Simplified  | Removed Slack Bolt dependency, uses new report types from engine     |
| `src/index.ts`              | Simplified  | Removed server mode, cleaner type usage                              |
| `package.json`              | Slimmed     | Removed `@slack/bolt`, `serve` script, Dockerfile                    |
| `tsconfig.json`             | Kept as-is  | Standard Node+ESM config                                             |
| `invariants.json`           | Kept as-is  | Zod-validated config format                                          |

### Parent B (cli-hooks) — Isolation Pattern + Output Scripts

| Component                        | Action                                     | Rationale                                                                                       |
| -------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Per-invariant isolation          | Grafted into `InvariantEngine.verifyAll()` | Each invariant gets its own try/catch — one failure doesn't block others                        |
| JSON report contract             | Adopted as output format                   | `{summary: {total, passed, failed, errors}, results: [...]}` is consumable by B's shell scripts |
| `scripts/post-slack.sh`          | Adapted                                    | Changed violation field access to match B's JSON contract (repo/file/line)                      |
| `scripts/post-github-comment.sh` | Adapted                                    | Same field name alignment                                                                       |
| Workflow: pipe stdout            | Adopted                                    | CLI mode outputs JSON to stdout, consumable by shell scripts                                    |

### Parent A (pure-github-action) — CLAUDE.md

| Component   | Action                  | Rationale                                                                                                        |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md` | Adapted for SDK context | Changed invariant format docs from YAML to JSON, added output contract section, kept verification steps and tips |

## Integration Challenges

1. **Type system unification**: Parent C's `Violation` type had `invariantId`, `description`, `severity`, `repo`, `message`, `details` fields. Parent B's contract uses `repo`, `file`, `line`, `detail`. Created new types in the engine matching B's contract while preserving C's Zod validation.

2. **stdout vs stderr**: Parent C logged progress to `console.log` (stdout). Parent B expected clean JSON on stdout. Changed all progress logging to `console.error` so stdout is reserved for the JSON report.

3. **Report shape**: Parent C's `VerificationSummary` had `totalInvariants`, `passed`, `failed`, `violations[]`, `durationMs`. Parent B's shape has `summary.{total, passed, failed, errors}` and per-result `violations[]`. Rewrote to match B's shape, which is more detailed (per-invariant results vs flat violation list).

4. **Slack output path**: Parent C used Slack Bolt SDK (full bot). Parent B used `curl` to webhook. Chose B's approach — simpler, stateless, runs in CI without a long-lived process.

## New Connective Tissue Invented

1. **`InvariantResult` type**: Bridges C's per-invariant verification with B's JSON report contract. Contains `id`, `description`, `severity`, `status`, `message`, `violations[]`, and optional `error`.

2. **`VerificationReport` type**: Top-level report type combining B's `summary` shape with per-result details. Used by both the engine and ci-trigger.

3. **`exitCodeForReport()`**: Replaces C's `exitCodeForSummary()` — works with the new report type and checks severity at the result level.

## What Was Lost From Non-Dominant Parents

### From Parent A

- Zero-code simplicity (A required no custom code)
- `claude-code-action@v1` direct usage
- YAML invariant format

### From Parent B

- `verify-invariants.sh` orchestrator (replaced by TypeScript engine)
- `yq` dependency (JSON, not YAML)
- Full shell-pipe composability (partially preserved)

### From Parent C

- Server mode (Slack Bolt bot), `SlackNotifier` class
- `Dockerfile`
- `findReferences()` in SourcegraphClient
- Threaded Slack violation reports

## Seam Locations

1. **`invariant-engine.ts` <-> `sourcegraph-client.ts`**: Engine calls `sg.keywordSearch()` and `sg.searchInRepos()`. Client returns `RepoMatch[]` and `Map<string, SearchResult[]>`.

2. **`index.ts` <-> `ci-trigger.ts`**: Index delegates CI logic to ci-trigger via the `VerificationReport` type.

3. **TypeScript stdout <-> Shell scripts**: `index.ts` outputs JSON to stdout. Shell scripts consume via stdin pipe. The JSON report contract is the seam.

4. **`invariants.json` <-> Zod schema**: Config validated at load time. Zod schema in `invariant-engine.ts` is the source of truth.

## Self-Assessed Coherence: 4/5

Strong coherence. The TypeScript core (C) integrates cleanly with B's isolation pattern and output contract. The CLAUDE.md (A) documents the JSON format accurately. The main tension is having two PR comment posting paths (TypeScript `postPRComment()` and shell `post-github-comment.sh`) — intentional flexibility, not incoherence.

Deduction: Shell scripts feel slightly foreign in a TypeScript project. Kept for composability with non-TypeScript workflows.

## Estimated Effort to Production-Ready

**1-2 days**

- [ ] `npm install` and verify `tsc` compiles clean
- [ ] Integration test with real Sourcegraph instance
- [ ] Add `.gitignore` for `node_modules/` and `dist/`
- [ ] Wire up GitHub Actions secrets
- [ ] Test PR comment posting on a real PR
- [ ] Test scheduled Slack webhook delivery

## Line Count

| File                                    | Lines     | Origin         |
| --------------------------------------- | --------- | -------------- |
| `src/sourcegraph-client.ts`             | 178       | C (kept)       |
| `src/invariant-engine.ts`               | 273       | C+B (modified) |
| `src/ci-trigger.ts`                     | 148       | C (simplified) |
| `src/index.ts`                          | 149       | C (simplified) |
| `scripts/post-slack.sh`                 | 95        | B (adapted)    |
| `scripts/post-github-comment.sh`        | 89        | B (adapted)    |
| `CLAUDE.md`                             | 74        | A (adapted)    |
| `.github/workflows/invariant-check.yml` | 81        | B+C (combined) |
| `invariants.json`                       | 64        | C (kept)       |
| `package.json`                          | 22        | C (slimmed)    |
| `tsconfig.json`                         | 16        | C (kept)       |
| **Total**                               | **1,189** | vs C's 1,242   |

Net reduction from Parent C: removed SlackNotifier (198 lines), Dockerfile (21 lines), simplified index (242->149). Engine grew (229->273) due to B's report types and isolation. Added shell scripts (184 lines) from B for composability. TypeScript core is 748 lines.
