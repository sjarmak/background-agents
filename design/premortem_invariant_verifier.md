# Premortem: Cross-Repo Invariant Verifier

3 independent failure analysts wrote narratives from 6 months in the future where this project FAILED.
All 3 rated their scenario **Critical severity, High likelihood**.

## 1. Risk Registry

| #   | Failure Lens             | Severity | Likelihood | Score  | Root Cause                                                                                                     | Top Mitigation                                                   |
| --- | ------------------------ | -------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Technical Architecture   | Critical | High       | **12** | One-Claude-call-per-invariant scales linearly with no parallelism path; Bash can't retrofit concurrency safely | Batch invariants OR parallelize with temp files + `jq -s` merge  |
| 2   | Integration & Dependency | Critical | High       | **12** | All 3 core deps fetched unpinned at runtime with no integration test to detect breakage                        | Pin versions + add canary invariant + shared sourced library     |
| 3   | Operational              | Critical | High       | **12** | System treated as "just a GitHub Action" instead of production infrastructure gating code merges for 50+ devs  | Cost caps + circuit breaker + partial-result detection + runbook |

## 2. Cross-Cutting Themes

### Theme A: Silent failure is the universal killer

All 3 narratives independently described the same pattern: the system fails silently, continues reporting "pass", and real violations ship to production undetected.

- **Tech**: Timeout kills the run mid-loop → partial results look like full results
- **Deps**: MCP tool rename → zero search results → "zero violations" = pass
- **Ops**: Invariant checks timeout → dropped from report → "3 passed" when 3 of 6 were skipped

**Combined severity**: This is the single most dangerous failure mode. If the system fails, it MUST fail loudly.

### Theme B: Linear cost scaling with no budget visibility

- **Tech**: 47 invariants × $0.80 each = $37/run, 50 PRs/day = $1,850/day
- **Ops**: Sourcegraph outage → 14 concurrent runs retrying for 6 hours = $6,200/week
- Both narratives converged on the same number range ($1,400-6,200/month) independently

**Combined severity**: Cost explosion is near-certain without caps. The ANTHROPIC_API_KEY has no spend limit today.

### Theme C: "Harden later" items never get hardened

- **Tech**: P2 items (circuit breaker, memory fix) deferred to Week 3 → Week 3 spent building new agents instead
- **Ops**: Stress test findings treated as "nice to have" → all shipped unfixed → all contributed to the failure

**Combined severity**: The 4-week roadmap's pace pressure guarantees P1/P2 items get displaced by new agent work.

## 3. Mitigation Priority List

| Priority | Mitigation                                                                                                                               | Failure Modes Addressed                                      | Effort |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| **1**    | **Add canary invariant** — synthetic test case with guaranteed violation; if not detected, entire run = error                            | Silent dep failure, silent tool rename, zero-results-as-pass | Low    |
| **2**    | **Pin all dependency versions** with checksums; use Renovate/Dependabot for update PRs                                                   | Supply chain, breaking changes, yq compromise                | Medium |
| **3**    | **Add per-invariant timeout** (`timeout 120 claude -p ...`) + report timed-out checks as `"status": "timeout"` distinct from pass/fail   | Timeout cascade, partial results, silent skipping            | Low    |
| **4**    | **Distinguish partial from complete results** — output must include `checked` vs `expected` count; flag mismatch in PR comment and Slack | Silent partial failure (all 3 narratives)                    | Low    |
| **5**    | **Add cost controls** — Anthropic API spend limit + pre-flight cost estimation + abort if over budget                                    | Cost explosion (both Tech and Ops narratives)                | Medium |
| **6**    | **Parallelize invariant checks** — `xargs -P` or temp files + `jq -s` merge (replace sequential loop)                                    | Linear scaling wall, timeout at 15+ invariants               | Medium |
| **7**    | **Add Sourcegraph circuit breaker** — canary query before main loop; abort if latency > 5s                                               | Sourcegraph outage cascade, retry storms                     | Low    |
| **8**    | **Extract shared `lib/` directory** — `sourcegraph.sh`, `slack.sh`, `github.sh` sourced by all agents                                    | Fix propagation across Week 2-4 agents, copy-paste drift     | Medium |
| **9**    | **Write runbook before scaling** — triage failed runs, emergency disable, secret rotation, ownership                                     | Operational blind spots, incident response gaps              | Low    |
| **10**   | **Block P1/P2 fixes from being displaced** — stress test findings become launch-blocking GitHub issues                                   | "Harden later" never happens                                 | Low    |

## 4. Design Modification Recommendations

### Mod 1: Add canary invariant + completeness check (addresses all 3 failure modes)

Add a synthetic invariant targeting a test fixture repo with a guaranteed violation. If the canary doesn't fire, the entire run is marked as `error`. Additionally, the report JSON must include `invariants_expected` vs `invariants_checked` — any mismatch is flagged in output.

**Effort**: Low (1-2 hours). **Addresses**: Silent dep failure, silent tool rename, partial results, timeout masking.

### Mod 2: Pin deps + add integration smoke test (addresses Tech + Deps)

Pin `@nicepkg/sourcegraph-mcp@x.y.z`, `@anthropic-ai/claude-code@x.y.z`, `yq@vX.Y.Z` with SHA256 checksums. Add a CI job that runs a single invariant against a fixture repo and asserts the expected JSON structure. Run this on dependency update PRs and weekly.

**Effort**: Medium (half day). **Addresses**: Supply chain, breaking changes, tool renames, silent MCP failure.

### Mod 3: Per-invariant timeout + parallelism + cost cap (addresses Tech + Ops)

Wrap each `claude -p` in `timeout 120`. Replace sequential loop with `xargs -P 4` writing to temp files, then `jq -s` merge. Add pre-flight cost estimation: `invariant_count × $1.50 estimated_cost`; abort with alert if over configurable threshold.

**Effort**: Medium (half day). **Addresses**: Scaling wall, timeout cascade, cost explosion, O(n²) memory.

### Mod 4: Operational readiness gate before Week 2 (addresses Ops)

Before building the next agent, complete: runbook, cost dashboard (even a simple weekly `jq` over GH Actions logs), Slack heartbeat check, PR comment deduplication, `maxItems` cap in schema. Track as launch-blocking issues.

**Effort**: Low-Medium (1-2 days). **Addresses**: "Harden later" displacement, monitoring gaps, alert fatigue.

## 5. Full Failure Narratives

### Technical Architecture Failure

47 invariants overwhelmed the sequential Bash loop. 15-minute timeout killed every PR check. O(n²) memory from string accumulation caused OOM. Parallelization attempted in Bash broke JSON aggregation. $1,400/month bill. All 3 agents disabled. Root cause: one-Claude-call-per-invariant with no batching or parallelism path.

### Integration & Dependency Failure

`@nicepkg/sourcegraph-mcp` 2.0 renamed MCP tools. Zero search results silently passed as "no violations" for 3 weeks. Two critical invariants violated. Production Sev-1 from unauthed endpoint. Then Claude CLI 2.x broke `--bare` and `--mcp-config` flags across all agents simultaneously. yq supply chain scare halted all development. Root cause: unpinned runtime-fetched dependencies with no integration test.

### Operational Failure

Sourcegraph outage + no circuit breaker = $6,200 API bill in one week. Slack webhook secret rotated = 3 weeks of silent notification failure. Partial results indistinguishable from complete results. Developers learned to ignore stale PR comments. Two critical violations shipped. No runbook, no cost visibility, no structured logs. Root cause: treated as developer tool instead of production infrastructure.
