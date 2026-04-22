# PRD: CI/CD Pipeline for Cross-Repo Invariant Verifier

**Author:** Research Agent
**Date:** 2026-04-05
**Status:** Draft (Refined)

---

## Convergence Notes

This section documents changes made during refinement and why.

### Fact-Check Corrections

1. **YAML vs JSON parity is worse than described.** The PRD mentioned parity as an open question, but the actual files have substantive divergences: YAML uses `""` for empty language/pattern fields while JSON uses `null`; YAML messages differ from JSON (e.g., `"silent auth bypass risk"` vs `"this causes silent auth bypass"`); YAML search patterns lack proper regex escaping (`grpc.Dial` vs `grpc\.Dial`). JSON should be the source of truth since the TS path reads JSON and the Zod schema validates it.
2. **Scheduled workflow already has `permissions: contents: read`.** The PRD claimed it was "missing explicit block" -- it is not missing.
3. **Shell script already handles canary validation** (lines 340-349 of `verify-invariants.sh`), but it still exits 1 when canary fails because the final gate counts ALL failures including canary. The workflow failure gate (`jq -r '.summary.failed'`) also has no canary exclusion.
4. **`exitCodeForReport()` in the TS path blocks on canary** because canary has `severity: critical` and the function blocks on all critical/high failures. This is the real bug.
5. **`invariants.json` is not in the PR workflow's paths trigger** -- only `invariants.yaml` is listed, but the TS path reads `invariants.json`.

### Scope Reductions (Over-Engineering Removed)

1. **Biome/linter removed from scope.** The project has 4 TypeScript files totaling ~500 lines. Adding a linter adds dependency overhead and CI time for negligible benefit. `tsc --noEmit` with `strict: true` already provides strong quality gating. Linting can be added later if the project grows.
2. **Daily critical-only schedule removed.** With 5 invariants and a total scan time of 5-15 minutes, running weekly is sufficient. The daily schedule doubles Actions minutes for minimal benefit.
3. **Email notifications removed.** Slack already covers the scheduled workflow. Adding email notification via `actions/github-script` is complexity for a second channel nobody asked for.
4. **`history.jsonl` trend tracking removed.** Over-engineering for a project with 5 invariants and no monitoring dashboard. Artifacts are retained for 30 days; that is sufficient.
5. **4-week milestone plan collapsed to 2 phases.** Most of the "Phase 2-4" items were gold-plating or deferred concerns, not CI setup.
6. **Manual dispatch inputs simplified.** The proposed `max_parallel`, `verbose`, and `notify_slack` inputs are unnecessary -- the shell script already has sensible defaults and always notifies Slack on the scheduled workflow.

### Open Questions Resolved

1. **PR workflow should use the TS/GraphQL path.** Confirmed. The shell path requires Claude OAuth, costs ~$0.25 per run, and is slower. The TS path calls Sourcegraph GraphQL directly. This is the single highest-impact change.
2. **Medium/low violations should not block merge.** Confirmed from code: `exitCodeForReport()` already only blocks on critical/high. The workflow failure gate is the one that over-counts.
3. **Canary should appear in PR comment with a special note.** The `formatPRComment()` function already renders it as a regular failure row. Adding `(expected)` to the canary row is a small code change worth making.
4. **JSON is source of truth.** The TS path reads `invariants.json`; the shell path reads `invariants.yaml`. Since the TS path is becoming the CI path, JSON wins. The YAML file should be generated from JSON (or removed), not the other way around.
5. **Claude OAuth rotation.** If the PR workflow switches to TS/GraphQL, Claude OAuth is only needed for the scheduled workflow. The token refresh problem still exists but affects one workflow instead of two.

### Tensions Identified (Not Resolved -- Team Decision Required)

1. **Should the scheduled workflow also switch to the TS path?** The PRD recommends keeping the shell/Claude path for "deeper analysis," but the Claude path does not actually produce deeper analysis -- it produces the same JSON report via a more expensive, less reliable mechanism. The team should decide if there is genuine value in the Claude-backed path or if both workflows should use TS/GraphQL.

---

## Summary

This PRD defines the CI/CD improvements for the cross-repo invariant verifier. The project has two GitHub Actions workflows (`invariant-check-pr.yml` and `invariant-check-scheduled.yml`), shell scripts for PR comments and Slack, a comprehensive e2e test suite, and both TypeScript/GraphQL and shell/Claude verification paths.

The verifier intentionally produces failures (the canary invariant always fails), so CI must distinguish between "the verifier found violations" (expected, reported to humans) and "the verifier itself is broken" (CI should hard-fail). The existing workflows partially handle this, but the canary is not excluded from the failure gate, and the PR workflow uses the expensive Claude-backed path when the cheaper GraphQL path would suffice.

---

## Goals

1. **Switch the PR workflow to the TS/GraphQL path** -- eliminates Claude dependency, reduces cost from ~$0.25/run to $0, and removes OAuth token management from the critical path.
2. **Fix the canary exclusion bug** so canary failures do not block PR merges while canary absence does.
3. **Add TypeScript build check** (`tsc --noEmit`) as a fast quality gate before expensive verification.
4. **Add Node.js setup with caching** to reduce install time.
5. **Ensure `invariants.json` is the source of truth** and add it to the PR trigger paths.

## Non-Goals

- Linter setup (project is too small to justify).
- Daily scheduling (weekly is sufficient for 5 invariants).
- Monitoring dashboard, trend tracking, or email notifications.
- Automated deployment (this is a CLI/CI tool).
- Migrating the scheduled workflow away from the shell path (team decision pending).
- Running the MCP backend in CI (requires Claude Agent SDK auth, slower, no advantage).

---

## Design

### 1. PR Workflow Changes

#### 1.1 Switch to TS/GraphQL Path

The single most impactful change. Replace the shell path with the TS path:

```yaml
# Current (expensive, requires Claude OAuth):
#   scripts/verify-invariants.sh -v > report.json || true

# Proposed (free, direct Sourcegraph GraphQL):
- name: Install dependencies
  run: npm ci

- name: Verify cross-repo invariants
  id: verify
  env:
    SOURCEGRAPH_URL: ${{ secrets.SOURCEGRAPH_URL }}
    SRC_ACCESS_TOKEN: ${{ secrets.SRC_ACCESS_TOKEN }}
  run: |
    npx tsx src/index.ts --mode=ci > report.json 2>verify-stderr.log || true
```

This eliminates the need for: `claude` CLI install, Claude OAuth credentials setup, `yq` install, `mcp-config.json`, and `invariants.schema.json` in the PR workflow.

**PR comment dedup must stay in the workflow YAML.** The TS path's `postPRComment()` creates a new comment every time (no marker-based dedup). The existing workflow YAML dedup logic (marker search + PATCH) should be retained and should wrap the TS output rather than calling `postPRComment()` from inside the TS process. Use `--mode=cli` (not `--mode=ci`) to get JSON output, then format via `post-github-comment.sh --format-only`.

#### 1.2 Add Build Check Job

```yaml
jobs:
  build-check:
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - run: npx tsc --noEmit

  verify-invariants:
    needs: build-check
    # ... existing verification logic, switched to TS path
```

This lets PRs fail fast on type errors (~30s) without waiting for Sourcegraph queries.

#### 1.3 Fix Canary Exclusion in Failure Gate

Current failure gate counts all failures including canary. Replace with:

```bash
# Verify canary DID fail (pipeline integrity)
CANARY_STATUS=$(jq -r '.results[] | select(.id | startswith("canary-")) | .status' report.json)
if [[ "$CANARY_STATUS" != "fail" ]]; then
  echo "::error::Canary invariant did not fail — pipeline integrity compromised"
  exit 1
fi

# Count real (non-canary) critical/high failures only
REAL_FAILURES=$(jq '[.results[] | select(.id | startswith("canary-") | not) | select(.status == "fail") | select(.severity == "critical" or .severity == "high")] | length' report.json)
ERRORS=$(jq '.summary.errors // 0' report.json)

if [[ "$REAL_FAILURES" -gt 0 || "$ERRORS" -gt 0 ]]; then
  echo "::error::$REAL_FAILURES critical/high violation(s), $ERRORS error(s) found"
  exit 1
fi
```

Also fix `exitCodeForReport()` in `src/ci-trigger.ts` to exclude canary invariants:

```typescript
export function exitCodeForReport(report: VerificationReport): number {
  const hasBlocking = report.results.some(
    (r) =>
      r.status === "fail" &&
      !r.id.startsWith("canary-") &&
      (r.severity === "critical" || r.severity === "high"),
  );
  return hasBlocking ? 1 : 0;
}
```

#### 1.4 Add `invariants.json` to Trigger Paths

Currently only `invariants.yaml` is in the paths list, but the TS path reads `invariants.json`:

```yaml
paths:
  - "invariants.yaml"
  - "invariants.json" # ADD THIS
  - "CLAUDE.md"
  # ... rest of paths
```

#### 1.5 Add Node.js Setup with Caching

Both workflows lack explicit Node.js setup. Add to both:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "22"
    cache: "npm"
```

The `yq` install can be cached too, but it is only needed for the scheduled workflow (shell path). Not worth the complexity for the PR workflow after the TS switch.

#### 1.6 Pin Trust-Boundary Files (Retain As-Is)

The existing trust-boundary file pinning in the PR workflow is excellent security practice and should be retained. After switching to the TS path, the pinned files can be reduced to just `invariants.json` and `CLAUDE.md` (the shell scripts and `invariants.yaml` are no longer used in the PR workflow).

### 2. Scheduled Workflow Changes

#### 2.1 Add Node.js Setup

Even though the scheduled workflow uses the shell path, `node` and `npx` are required by the `claude` CLI install step. Pinning Node.js 22 ensures consistency:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "22"
    cache: "npm"
```

#### 2.2 Add Manual Dispatch Config Input

The only dispatch input worth adding is the config file selector:

```yaml
workflow_dispatch:
  inputs:
    config_file:
      description: "Invariants config file (YAML)"
      default: "invariants.yaml"
      type: string
```

#### 2.3 Add Token Masking

Add to both workflows at the start of any step that uses secrets:

```yaml
- name: Mask secrets
  run: |
    echo "::add-mask::${{ secrets.SRC_ACCESS_TOKEN }}"
    echo "::add-mask::${{ secrets.SOURCEGRAPH_URL }}"
```

#### 2.4 Add Date to Artifact Name

```yaml
- uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
  with:
    name: invariant-report-${{ github.run_id }}-$(date +%Y%m%d)
    path: report.json
    retention-days: 30
```

### 3. Source of Truth: JSON

**Make `invariants.json` the source of truth.** Reasons:

- The TS path (now the CI path for PRs) reads JSON.
- The Zod schema validates JSON structure with proper null handling.
- YAML has diverged from JSON in field values (empty strings vs null, message text differences, unescaped regex patterns).
- The shell path reads YAML via `yq`, but `yq` can also read JSON.

**Action:** Either add a `scripts/sync-invariants.sh` that generates YAML from JSON, or switch `verify-invariants.sh` to read JSON via `jq` (it already uses `jq` heavily). The simplest path: change line 133 of `verify-invariants.sh` to `INVARIANT_COUNT=$(jq '.invariants | length' "$CONFIG_FILE")` and stop maintaining YAML.

### 4. Secrets Management

| Secret                     | Used By                  | After TS Switch                                    |
| -------------------------- | ------------------------ | -------------------------------------------------- |
| `SRC_ACCESS_TOKEN`         | Sourcegraph GraphQL API  | Both workflows                                     |
| `SOURCEGRAPH_URL`          | Sourcegraph instance URL | Both workflows                                     |
| `CLAUDE_OAUTH_CREDENTIALS` | Shell path (claude CLI)  | Scheduled workflow only (removed from PR workflow) |
| `SLACK_WEBHOOK_URL`        | `post-slack.sh`          | Scheduled workflow only                            |
| `GITHUB_TOKEN`             | PR comments              | Auto-provided; `pull-requests: write` required     |

### 5. Sourcegraph Resilience

The TS/GraphQL path has a 30-second `AbortSignal.timeout` per query, which is appropriate. Two improvements worth making:

1. **Pre-flight health check:** Add a minimal GraphQL query before running invariants. If it fails, exit with code 2 (distinguishable from code 1 = violations found). The PR workflow can then post a "Sourcegraph unreachable, check skipped" comment instead of failing.

2. **Single retry for 5xx errors:** Add one retry with 5-second delay in `SourcegraphGraphQLClient.search()` for HTTP 5xx responses. Two consecutive failures indicate a real outage.

### 6. Canary in PR Comments

Update `formatPRComment()` to mark canary results as expected:

```typescript
const statusIcon = r.id.startsWith("canary-")
  ? "🔵 expected"
  : r.status === "pass"
    ? "✅"
    : r.status === "fail"
      ? "❌"
      : "⚠️";
```

---

## Milestones

### Phase 1: Critical Fixes (1 week)

These changes fix real bugs and deliver the highest-impact improvement:

1. **Switch PR workflow to TS/GraphQL path** -- eliminates Claude dependency, ~$0.25/run savings, faster execution
2. **Fix canary exclusion** in both the workflow failure gate and `exitCodeForReport()`
3. **Add Node.js 22 setup with npm caching** to both workflows
4. **Add `tsc --noEmit` build-check job** to PR workflow
5. **Add `npm ci`** step to PR workflow (required for TS path)
6. **Add `invariants.json` to PR trigger paths**
7. **Add token masking** (`::add-mask::`) to both workflows

### Phase 2: Hardening (1 week, lower priority)

These are improvements, not fixes:

8. **Add pre-flight Sourcegraph health check** to TS path (exit code 2 for connection failures)
9. **Add single retry** for 5xx in `SourcegraphGraphQLClient.search()`
10. **Add manual dispatch config input** to scheduled workflow
11. **Mark canary as "expected"** in PR comment formatting
12. **Consolidate to JSON source of truth** -- either remove YAML or auto-generate it
13. **Add unit tests** for `exitCodeForReport`, `formatPRComment`, `detectCIContext` (Vitest)

---

## What Exists vs What Does Not

### Exists and Works

- Both workflow files (`.github/workflows/invariant-check-pr.yml`, `invariant-check-scheduled.yml`)
- Shell scripts: `verify-invariants.sh`, `post-github-comment.sh`, `post-slack.sh`
- TypeScript path: `src/index.ts`, `src/invariant-engine.ts`, `src/sourcegraph-client.ts`, `src/ci-trigger.ts`
- PR comment dedup (marker-based upsert in workflow YAML)
- Trust-boundary file pinning (base branch override in PR workflow)
- Concurrency control (`cancel-in-progress: true` for PRs, `false` for scheduled)
- E2e test suite (`tests/e2e-verify.sh`) covering both paths
- Canary invariant definition and detection in shell path
- SHA-pinned third-party actions
- Permissions blocks on both workflows

### Exists but Has Bugs

- `exitCodeForReport()` does not exclude canary (blocks on all critical/high)
- PR workflow failure gate does not exclude canary
- `invariants.yaml` and `invariants.json` have diverged (field values, message text, regex escaping)
- PR trigger paths list does not include `invariants.json`
- `postPRComment()` in TS path has no dedup (creates new comment every time)

### Does Not Exist

- Node.js setup in either workflow
- `npm ci` in PR workflow (TS path needs dependencies)
- Build/type check job
- Linter configuration (intentionally deferred)
- Unit tests for pure functions
- Sourcegraph pre-flight health check in TS path
- Retry logic for transient API errors
- Token masking in workflow steps
- Manual dispatch inputs on scheduled workflow

---

## Open Questions (Remaining)

1. **Should the scheduled workflow also switch to the TS/GraphQL path?** The shell/Claude path does not produce meaningfully different results, but changing it has lower urgency since it runs once a week. Team decision.

2. **Is demo.sourcegraph.com the long-term instance?** If the team moves to self-hosted, the `SOURCEGRAPH_URL` secret and rate limits change. No action needed now.

3. **Should YAML be removed entirely?** The shell path reads YAML, but if both workflows eventually use the TS path, YAML becomes dead weight. This depends on the answer to question 1.

---

## Premortem: Failure Scenarios

Each scenario is written as a narrative from three months in the future, followed by a structured assessment.

### 1. Sourcegraph API Failures in CI

_It is three months from now and demo.sourcegraph.com had a 4-hour outage on a Tuesday morning. Every PR opened during that window got a red X on the invariant check. Three engineers spent time investigating before realizing the external service was down. Two PRs that needed urgent merge were blocked. The team had to manually re-run workflows after the outage resolved._

**Why this is plausible:** The `SourcegraphGraphQLClient.search()` method (line 131 of `sourcegraph-client.ts`) has a hard 30-second `AbortSignal.timeout` per request and throws on any non-200 response with no retry. If Sourcegraph returns a 503 or times out, the entire invariant run errors out. The PR workflow failure gate (line 113 of `invariant-check-pr.yml`) then fires because `ERRORS` is greater than zero. There is no pre-flight health check and no distinction between "Sourcegraph is down" (exit code 2) and "violations found" (exit code 1) -- the catch block in `main()` does use exit code 2, but individual search failures within `verifyAll` are caught as `status: "error"` and counted against the error total, which the failure gate treats identically to violations.

- **Likelihood**: High -- demo.sourcegraph.com is a shared demo instance, not an SLA-backed production endpoint.
- **Impact**: Medium -- blocks PR merges during outage, wastes engineer attention, but no data loss.
- **Mitigation**: Implement the pre-flight health check proposed in the PRD (Section 5). If it fails, post a "Sourcegraph unreachable, check skipped" comment and exit 0 so the check becomes informational rather than blocking. Add a single retry with 5-second backoff for 5xx responses in `SourcegraphGraphQLClient.search()`.

### 2. Secret Rotation

_It is three months from now and the `SRC_ACCESS_TOKEN` expired silently. The weekly scheduled run started failing with `401 Unauthorized`, but nobody noticed for three weeks because Slack notifications themselves succeeded -- they just reported an error status that looked like "Sourcegraph had a bad day." The PR workflow had been switched to the TS path, so every single PR was also failing. An engineer finally investigated after a new team member asked why invariant checks always fail._

**Why this is plausible:** The `SRC_ACCESS_TOKEN` is used by both workflows (confirmed in the secrets table in Section 4 of the PRD). There is no startup validation of token validity -- `requireEnv()` (line 65 of `index.ts`) only checks the variable is non-empty, not that it authenticates. The Sourcegraph client throws a generic `Sourcegraph API error: 401 Unauthorized` (line 145 of `sourcegraph-client.ts`) which gets caught as an error, not distinguished from a search-level failure. The scheduled workflow posts to Slack regardless (`if: always()`), but the Slack message for an error run looks similar to a run with violations, making it easy to ignore.

- **Likelihood**: Medium -- Sourcegraph access tokens on demo instances can have expiry policies; the team may not have calendar reminders.
- **Impact**: High -- both workflows silently degrade; the invariant verifier provides no value until someone manually investigates and rotates the token.
- **Mitigation**: Add a pre-flight token validation step that makes a minimal authenticated API call (e.g., `query { currentUser { username } }`) at the start of each run. If it returns 401, fail with a distinct, unmistakable error message. Add a Slack-specific alert for authentication failures that is visually different from a normal violation report.

### 3. Canary Invariant Bug

_It is three months from now and Sourcegraph rotated their demo dataset. The string "Licensed under the Apache License" no longer appears in any indexed repository. The canary invariant started passing (zero matches for `must_not_exist` means pass), which means the entire pipeline is silently broken -- the canary was supposed to always fail. But `exitCodeForReport()` (line 141 of `ci-trigger.ts`) does not exclude canary from its blocking check, so when canary passes, the overall result just looks "clean." The failure gate in the PR workflow (line 109 of `invariant-check-pr.yml`) also does not check for canary absence. The team believed all invariants were passing for weeks while Sourcegraph was returning no results for any search._

**Why this is plausible:** The canary relies on a specific string existing in Sourcegraph's index. The PRD (Section 1.3) proposes a canary validation step that checks `CANARY_STATUS != "fail"` and errors, but this has not been implemented yet. The shell path (`verify-invariants.sh`, lines 340-349) does validate canary in the scheduled workflow, but the TS path has no equivalent logic. If the PRD's Phase 1 changes are implemented partially -- switching to the TS path without also adding canary validation -- the safety net disappears.

- **Likelihood**: Medium -- demo dataset changes are outside the team's control; partial implementation of the PRD is a realistic scenario.
- **Impact**: High -- the entire verification pipeline becomes theater; violations are silently missed with no alert.
- **Mitigation**: Implement canary validation as an atomic change with the TS path switch -- never deploy one without the other. The validation must check that at least one canary invariant exists in the config AND that it has `status: "fail"` in the report. Make this a hard error (exit 1) with a specific `::error::` annotation. Add a unit test for this logic.

### 4. Config Drift

_It is three months from now and a new invariant was added to `invariants.json` for a security audit. The engineer did not know `invariants.yaml` existed. The weekly scheduled run (shell path, reads YAML) continued checking only the original 5 invariants. The PR workflow (TS path, reads JSON) checked 6. The security team believed the new invariant was being checked weekly; it was not._

**Why this is plausible:** The divergence already exists today. Comparing the files: YAML uses empty strings (`""`) for null fields while JSON uses `null`; YAML's `auth-init-required` message says "silent auth bypass risk" while JSON says "this causes silent auth bypass"; YAML's `grpc-timeout-required` search pattern uses unescaped dots (`grpc.Dial`) while JSON properly escapes them (`grpc\.Dial`). The PRD acknowledges this in Fact-Check Correction #1 and proposes JSON as source of truth, but if the scheduled workflow continues using the shell path (which reads YAML via `yq`), two configs remain in play.

- **Likelihood**: High -- the divergence already exists and will worsen with any change that only touches one file.
- **Impact**: Medium -- invariants checked in one context but not the other; false confidence in coverage.
- **Mitigation**: Resolve the open question (PRD Section, Open Questions #1) about switching the scheduled workflow to the TS path. If the shell path is kept, add a CI step that validates YAML and JSON are semantically equivalent (`jq` the JSON, `yq` the YAML, diff the normalized output). Better yet, auto-generate YAML from JSON in a pre-commit hook or remove YAML entirely.

### 5. PR Comment Spam

_It is three months from now and a PR with 12 pushes has 12 invariant check comments. The deduplication broke during the TS path migration: someone ran the TS process in `--mode=ci` instead of `--mode=cli`, which called `postPRComment()` directly (line 137 of `index.ts`) -- creating a new comment with no marker-based dedup -- and then the workflow YAML also ran its own dedup logic, creating a second comment per push._

**Why this is plausible:** The `postPRComment()` function (line 110 of `ci-trigger.ts`) does a raw `POST` to the GitHub comments API with no dedup logic whatsoever -- no marker search, no PATCH of existing comments. The PRD explicitly warns about this (Section 1.1): "PR comment dedup must stay in the workflow YAML" and recommends using `--mode=cli` not `--mode=ci`. But the mode flag defaults to `ci` when `GITHUB_ACTIONS === "true"` (line 62 of `index.ts`), so if the workflow step does not explicitly pass `--mode=cli`, the TS process will auto-detect CI mode and call `postPRComment()` itself. This is a footgun waiting to fire.

- **Likelihood**: High -- the auto-detection logic and the PRD recommendation are in direct tension; a single missing flag causes the problem.
- **Impact**: Low -- annoying comment spam, but no functional harm; engineers can still find the latest result.
- **Mitigation**: Either (a) remove `postPRComment()` from the CI mode entirely and always rely on the workflow YAML's dedup logic, or (b) add marker-based dedup to `postPRComment()` itself. Option (a) is simpler and aligns with the PRD recommendation. Additionally, change the auto-detection default: when `GITHUB_ACTIONS === "true"` and no explicit `--mode=` is passed, default to `cli` not `ci`, so the TS process never posts comments on its own unless explicitly asked.

### 6. Cost Creep

_It is three months from now and GitHub Actions usage is 4x higher than expected. The PR workflow triggers on every push to any branch that touches `.ts`, `.js`, `.go`, `.py`, or `.java` files (line 7-16 of `invariant-check-pr.yml`). A busy week with 15 PRs averaging 8 pushes each means 120 workflow runs. Each run installs `claude-code` globally (line 57), installs `yq`, and makes 5+ Sourcegraph API calls. After the TS path switch, the Claude cost drops to zero, but the Actions minutes add up. The scheduled workflow is fine at once per week._

**Why this is plausible:** The path triggers are broad -- any `.ts` file change in any directory triggers the workflow. The `npm install -g @anthropic-ai/claude-code@1.0.33` step (line 57 of `invariant-check-pr.yml`) downloads a large npm package on every run. After the TS path switch, this step should be removed, but if it is left in by oversight, it wastes ~30 seconds per run. More significantly, `npm ci` for the project's own dependencies and Sourcegraph API calls scale linearly with pushes.

- **Likelihood**: Low -- GitHub's free tier is 2,000 minutes/month for private repos; 120 runs at ~3 minutes each is 360 minutes, well within limits. For public repos, minutes are unlimited.
- **Impact**: Low -- unlikely to exceed free tier for a project this size; Sourcegraph demo instance has no billing.
- **Mitigation**: The `cancel-in-progress: true` concurrency setting (line 19-20 of `invariant-check-pr.yml`) already mitigates this by canceling stale runs when a new push arrives on the same PR. After the TS path switch, remove the `yq` install and `claude-code` install steps. Add `npm` caching via `actions/setup-node` as the PRD recommends. No further action needed unless the team grows significantly.

### 7. False Sense of Security

*It is three months from now and a new service imported `auth-lib` using a dynamic require pattern: `const lib = require(getAuthPackage())`. The `auth-init-required` invariant's search pattern (`import.*auth-lib|require._auth-lib|from auth_lib`) missed it entirely because there is no literal string `auth-lib`on the require line. The service shipped without`auth.init()` and caused a production auth bypass. The invariant check had been passing green for weeks._

**Why this is plausible:** Every invariant uses simple keyword/regex search against Sourcegraph. The search patterns are narrow by design -- they search for specific string literals. The `count:100` limit (line 99 of `sourcegraph-client.ts`) means any invariant matching more than 100 files gets truncated results with only a stderr warning, not a failure. The `grpc-timeout-required` invariant searches for `grpc.Dial|grpc.NewClient|grpcClient.` -- the trailing dot in `grpcClient.` is not regex-escaped in YAML (though it is in JSON as `grpcClient\\.`), meaning the YAML version matches `grpcClientX` and other false positives. The `must_contain` assertion with `scope: file` for gRPC checks whether `WithTimeout` appears anywhere in the same file, not whether it is applied to the specific call -- a file with one guarded call and one unguarded call would pass.

- **Likelihood**: High -- the invariants are intentionally coarse (keyword search, not AST analysis), and the gap between what they check and what engineers believe they check will widen as the codebase evolves.
- **Impact**: Medium -- a missed invariant violation could cause a production incident, but the invariants cover defense-in-depth patterns (auth init, db client consolidation) rather than being the sole safeguard.
- **Mitigation**: Document the known limitations of keyword-based search in the invariant definitions themselves (add a `limitations` field or comments). For critical invariants like `auth-init-required`, add multiple search pattern variants to catch common import styles. Consider raising the `count:100` cap to `count:500` for critical invariants and treating truncation as a warning in the report. Long-term, evaluate Sourcegraph's structural search (`type:structural`) for pattern matching that understands code structure.

---

## Top 3 Risks

Ranked by likelihood multiplied by impact:

| Rank | Scenario                      | Likelihood | Impact | Score    | Key Mitigation                                                                                                                                                                 |
| ---- | ----------------------------- | ---------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | **Canary invariant bug** (#3) | Medium     | High   | **High** | Implement canary validation atomically with the TS path switch; never ship one without the other. Add a unit test that asserts canary absence causes exit code 1.              |
| 2    | **Secret rotation** (#2)      | Medium     | High   | **High** | Add pre-flight `currentUser` query to validate token on every run. Make 401 errors visually distinct in Slack notifications so they cannot be confused with normal violations. |
| 3    | **Config drift** (#4)         | High       | Medium | **High** | Eliminate YAML as an independent config. Either auto-generate it from JSON or switch the scheduled workflow to the TS path so only one config file exists.                     |

Honorable mention: **False sense of security** (#7) scores high-likelihood but medium-impact because the invariants are a defense-in-depth layer, not a primary control. It warrants documentation and gradual improvement but is not an urgent operational risk.
