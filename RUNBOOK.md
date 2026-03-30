# Cross-Repo Invariant Verifier — Runbook

## 1. System Overview

The Cross-Repo Invariant Verifier is an automated system that checks organization-wide code invariants across all repositories indexed by Sourcegraph.

### Architecture

```
GitHub Actions (cron / PR trigger)
        |
        v
  Claude Code CLI
        |
        v
  invariants.yaml  -->  Agent reads invariants
        |
        v
  Sourcegraph MCP  -->  keyword_search / read_file / find_references
        |
        v
  report.json      -->  Violations written to artifact
        |
        v
  Slack webhook    -->  Notifications for failures
  PR comment       -->  Inline results on PRs
```

### Components

| Component                | Location  | Purpose                       |
| ------------------------ | --------- | ----------------------------- |
| `invariants.yaml`        | repo root | Invariant definitions         |
| `invariants.schema.json` | repo root | JSON Schema for validation    |
| `mcp-config.json`        | repo root | Sourcegraph MCP server config |
| `CLAUDE.md`              | repo root | Agent instructions            |
| `.github/workflows/`     | repo      | CI/CD triggers (cron + PR)    |
| `scripts/`               | repo      | Helper scripts for CI         |

## 2. How to Triage a Failed Run

1. **Check GitHub Actions logs**
   - Go to the repository's Actions tab
   - Find the failed workflow run
   - Read the Claude Code CLI output for error messages

2. **Read the report.json artifact**
   - Download the `report.json` artifact from the workflow run
   - Check `status` field: `"fail"` = violations found, `"error"` = infrastructure problem
   - For `"fail"`: review each violation's `repo`, `file`, `line`, and `detail`
   - For `"error"`: check the `error` field for the root cause

3. **Verify the canary invariant fired**
   - The `canary-verification-active` invariant MUST always produce a violation
   - If the canary passed (zero violations), the pipeline is broken — treat the entire run as unreliable
   - Check Sourcegraph connectivity if the canary didn't fire

4. **Check Sourcegraph health**
   - Verify the Sourcegraph instance is reachable at `$SOURCEGRAPH_ENDPOINT`
   - Check that repository indexing is up to date
   - Look for recent Sourcegraph incidents or maintenance windows

5. **Check API key validity**
   - Verify `ANTHROPIC_API_KEY` is valid: check the Anthropic dashboard for usage/errors
   - Verify `SOURCEGRAPH_TOKEN` hasn't expired: test with a manual API call
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
#       - 'invariants.yaml'
```

Push the change to disable all automated runs. Revert when ready to re-enable.

### Option B: Remove the schedule

Delete or rename the workflow file. This is the most aggressive option — use only if the system is causing active harm (e.g., spamming Slack, burning API budget).

## 4. Secret Rotation

| Secret                 | Stored In           | How to Rotate                                                                                               |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`    | GitHub repo secrets | Generate new key at console.anthropic.com > API Keys. Update in repo Settings > Secrets > Actions.          |
| `SOURCEGRAPH_ENDPOINT` | GitHub repo secrets | Update if the Sourcegraph instance URL changes.                                                             |
| `SOURCEGRAPH_TOKEN`    | GitHub repo secrets | Generate new token in Sourcegraph > User Settings > Access Tokens. Update in repo secrets.                  |
| `SLACK_WEBHOOK_URL`    | GitHub repo secrets | Create new webhook in Slack > App Settings > Incoming Webhooks. Update in repo secrets. Delete old webhook. |

After rotating any secret:

1. Trigger a manual workflow run to verify the new credentials work
2. Confirm the canary invariant fires successfully
3. Check Slack notifications are delivered (if `SLACK_WEBHOOK_URL` was rotated)

## 5. Adding / Modifying Invariants

### Process

1. **Create a PR** — all invariant changes require review
2. **Edit `invariants.yaml`** — add the new invariant following the existing format
3. **Validate against schema** — run: `ajv validate -s invariants.schema.json -d invariants.yaml`
4. **Respect the cap** — the schema enforces a maximum of 20 invariants (`maxItems: 20`). Remove or consolidate before adding if at the limit.
5. **Canary must still fire** — verify the `canary-verification-active` invariant is still the first entry and hasn't been removed
6. **Test locally** — run the verifier manually against the new invariant before merging

### Invariant Design Tips

- Use specific `search.pattern` values to minimize false positives
- Set `language` filter when the invariant is language-specific
- Choose the narrowest `scope` (`file` over `repo`) when possible
- Write actionable `message` text — engineers should know what to fix

## 6. Cost Management

### Expected Cost per Run

- Each invariant requires 1-3 Sourcegraph searches + 0-N file reads
- Claude API cost depends on the number of invariants and search result volume
- Typical run with 5 invariants: ~$0.50-$2.00 in API costs

### Controlling Costs

- **`MAX_COST_USD` env var** — set in the workflow to cap per-run spending (e.g., `MAX_COST_USD=5`)
- **Reduce invariant count** — fewer invariants = fewer searches = lower cost
- **Use language filters** — narrows search scope, reduces tokens processed
- **Monitor usage** — check the [Anthropic dashboard](https://console.anthropic.com/) for spend trends

### Budget Alerts

Set up billing alerts in the Anthropic console to get notified before hitting spend limits.

## 7. Common Failure Modes

| Symptom                                | Likely Cause                                                                | Fix                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Canary invariant passes (no violation) | Sourcegraph search is broken or canary marker was removed from fixture repo | Check Sourcegraph health; verify `canary-test-fixture` repo contains the marker                   |
| All invariants return zero results     | Sourcegraph token expired or endpoint unreachable                           | Rotate `SOURCEGRAPH_TOKEN`; check endpoint URL                                                    |
| Run times out                          | Too many search results or Sourcegraph is slow                              | Add language filters; reduce invariant count; check Sourcegraph performance                       |
| `"status": "error"` in report          | API key invalid, network error, or schema validation failure                | Check CI logs for the specific error message; verify secrets                                      |
| Slack notification missing             | Webhook URL invalid or Slack app deactivated                                | Test webhook manually with `curl`; regenerate if needed                                           |
| Schema validation fails                | `invariants.yaml` doesn't match `invariants.schema.json`                    | Run `ajv validate` locally; check for typos, missing required fields, or exceeding `maxItems: 20` |
| Cost spike                             | New invariant with broad search pattern                                     | Review search patterns; add language filters; set `MAX_COST_USD` cap                              |
| Duplicate/stale violations             | Sourcegraph index is behind                                                 | Check indexing status; wait for re-index or trigger manually                                      |

## 8. Ownership

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
