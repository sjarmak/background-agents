# Cross-Repo Invariant Verifier — Runbook

## 1. System Overview

The Cross-Repo Invariant Verifier is an automated system that checks organization-wide code invariants across all repositories indexed by Sourcegraph.

### Architecture

```
GitHub Actions (cron / PR trigger)
        |
        v
  src/index.ts  (TypeScript verifier)
        |
        v
  config/invariants.json  -->  InvariantEngine loads invariants
        |
        v
  Sourcegraph GraphQL API  -->  keyword search + per-repo assertion searches
        |
        v
  report.json      -->  Violations written to artifact
        |
        v
  Slack webhook    -->  Notifications for failures
  PR comment       -->  Inline results on PRs
```

Both workflows run the GraphQL backend. The Claude-agent/MCP backend
(`npx tsx src/index.ts --mode=cli --mcp`, configured by `config/mcp-config.json`
and instructed by `CLAUDE.md`) is opt-in for manual runs only.

### Components

| Component                | Location  | Purpose                       |
| ------------------------ | --------- | ----------------------------- |
| `config/invariants.json`        | repo `config/` | Invariant definitions         |
| `config/invariants.schema.json` | repo `config/` | JSON Schema for validation    |
| `config/mcp-config.json`        | repo `config/` | Sourcegraph MCP server config |
| `CLAUDE.md`                     | repo root      | Agent instructions (opt-in MCP path) + output contract |
| `.github/workflows/`            | repo           | CI/CD triggers (cron + PR)    |
| `scripts/`                      | repo           | Helper scripts for CI         |

## 2. How to Triage a Failed Run

1. **Check GitHub Actions logs**
   - Go to the repository's Actions tab
   - Find the failed workflow run
   - Read the verifier's stderr diagnostics in the step log for error messages

2. **Read the report.json artifact**
   - Download the `report.json` artifact from the workflow run
   - Check `status` field: `"fail"` = violations found, `"error"` = infrastructure problem
   - For `"fail"`: review each violation's `repo`, `file`, `line`, and `detail`
   - For `"error"`: check the `error` field for the root cause

3. **Verify the canary invariant fired**
   - The `canary-verification-active` invariant MUST always produce a violation
   - If the canary passed (zero violations), the pipeline is broken — treat the entire run as unreliable
   - Check Sourcegraph connectivity if the canary didn't fire
   - The weekly Slack message is canary-aware: it stays green when the canary is the only failure (context line "Pipeline health: OK (canary fired)"), and turns red with a ":rotating_light: PIPELINE BROKEN: canary did not fire" line — regardless of other results — when the canary passes or is missing

4. **Check Sourcegraph health**
   - Verify the Sourcegraph instance is reachable at `$SOURCEGRAPH_URL`
   - Check that repository indexing is up to date
   - Look for recent Sourcegraph incidents or maintenance windows

5. **Check API key validity**
   - Verify `SRC_ACCESS_TOKEN` hasn't expired: test with a manual API call
   - For manual `--mcp` runs only: verify Claude OAuth credentials are valid — `CLAUDE_OAUTH_CREDENTIALS` must contain a valid `claudeAiOauth` JSON with non-expired tokens (neither workflow uses this secret)
   - Check `SLACK_WEBHOOK_URL` is still active if Slack notifications are missing

## 3. Emergency Disable

### Option A: Comment out triggers

Edit the workflow YAML and comment out the `on:` triggers:

```yaml
# on:
#   schedule:
#     - cron: '0 9 * * 1'
#   pull_request:
#     paths:
#       - 'config/invariants.json'
```

Push the change to disable all automated runs. Revert when ready to re-enable.

### Option B: Remove the schedule

Delete or rename the workflow file. This is the most aggressive option — use only if the system is causing active harm (e.g., spamming Slack, burning API budget).

## 4. Secret Rotation

| Secret                     | Stored In           | How to Rotate                                                                                                                                                                    |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_OAUTH_CREDENTIALS` | GitHub repo secrets | Only needed for opt-in `--mcp` runs — neither workflow uses it. JSON contents of `~/.claude/.credentials.json` with `claudeAiOauth` object (accessToken, refreshToken, expiresAt). Copy from a machine with an active Claude subscription login. |
| `SOURCEGRAPH_URL`          | GitHub repo secrets | Sourcegraph instance URL (e.g., `https://sourcegraph.sourcegraph.com`). Update if instance changes.                                                                              |
| `SRC_ACCESS_TOKEN`         | GitHub repo secrets | Generate new token in Sourcegraph > User Settings > Access Tokens. Update in repo secrets.                                                                                       |
| `SLACK_WEBHOOK_URL`        | GitHub repo secrets | Create new webhook in Slack > App Settings > Incoming Webhooks. Update in repo secrets. Delete old webhook.                                                                      |

After rotating any secret:

1. Trigger a manual workflow run to verify the new credentials work
2. Confirm the canary invariant fires successfully
3. Check Slack notifications are delivered (if `SLACK_WEBHOOK_URL` was rotated)

## 5. Adding / Modifying Invariants

### Process

1. **Create a PR** — all invariant changes require review
2. **Edit `config/invariants.json`** — add the new invariant following the existing format
3. **Validate against schema** — run: `ajv validate -s config/invariants.schema.json -d config/invariants.json`
4. **Respect the cap** — the schema enforces a maximum of 20 invariants (`maxItems: 20`). Remove or consolidate before adding if at the limit.
5. **Canary must still fire** — verify the `canary-verification-active` invariant is still the first entry and hasn't been removed
6. **Test locally** — run the verifier manually against the new invariant before merging

### Invariant Design Tips

- Use specific `search.pattern` values to minimize false positives
- Set `language` filter when the invariant is language-specific
- Choose the narrowest `scope` (`file` over `repo`) when possible
- Write actionable `message` text — engineers should know what to fix

## 6. Common Failure Modes

| Symptom                                | Likely Cause                                                                | Fix                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Canary invariant passes (no violation) | Sourcegraph search is broken or canary marker was removed from fixture repo | Check Sourcegraph health; verify `canary-test-fixture` repo contains the marker                   |
| All invariants return zero results     | Sourcegraph token expired or endpoint unreachable                           | Rotate `SRC_ACCESS_TOKEN`; check endpoint URL                                                     |
| Run times out                          | Too many search results or Sourcegraph is slow                              | Add language filters; reduce invariant count; check Sourcegraph performance                       |
| `"status": "error"` in report          | API key invalid, network error, or schema validation failure                | Check CI logs for the specific error message; verify secrets                                      |
| Invariant reports `status: "error"` with `search truncated at result cap; violations may be missed` | Search pattern matched the GraphQL result cap (500), so the result set is incomplete | Narrow the `search.pattern`; add a `language` filter                                              |
| PR check fails with `config/invariants.json not found on base branch` | Base branch has no `config/invariants.json`; the trust boundary fails closed rather than running an empty ruleset | Restore `config/invariants.json` on the base branch                                               |
| Slack notification missing             | Webhook URL invalid or Slack app deactivated                                | Test webhook manually with `curl`; regenerate if needed                                           |
| Schema validation fails                | `config/invariants.json` doesn't match `config/invariants.schema.json`      | Run `ajv validate` locally; check for typos, missing required fields, or exceeding `maxItems: 20` |
| Duplicate/stale violations             | Sourcegraph index is behind                                                 | Check indexing status; wait for re-index or trigger manually                                      |

## 7. Ownership

| Role              | Contact                                            |
| ----------------- | -------------------------------------------------- |
| System owner      | Platform Engineering team                          |
| Escalation path   | Platform Engineering lead > Infrastructure on-call |
| Sourcegraph admin | Infrastructure team                                |
| Anthropic account | Platform Engineering lead                          |

### Escalation Process

1. **P3/P4** (informational, low severity) — file a ticket, fix in next sprint
2. **P2** (high severity violations found) — notify system owner, triage within 1 business day
3. **P1** (pipeline broken, canary not firing) — page Platform Engineering on-call, disable workflow if needed
4. **P0** (secret exposure, security invariant bypass) — immediate escalation to security team + secret rotation
