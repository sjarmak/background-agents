/**
 * Main entry point for the Cross-Repo Invariant Verifier.
 *
 * Modes:
 *   --mode=cli       One-shot verification, prints results, exits with code
 *   --mode=ci        CI mode — detects GitHub Actions context, posts PR comment
 *   --mode=server    Long-lived Slack bot + scheduled scans
 */

import { SourcegraphClient } from "./sourcegraph-client.js";
import { SlackNotifier } from "./slack-notifier.js";
import { InvariantEngine } from "./invariant-engine.js";
import {
  detectCIContext,
  formatPRComment,
  postPRComment,
  exitCodeForSummary,
} from "./ci-trigger.js";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

interface AppConfig {
  mode: "cli" | "ci" | "server";
  configPath: string;
  sourcegraph: {
    instanceUrl: string;
    accessToken: string;
  };
  slack?: {
    botToken: string;
    signingSecret: string;
    appToken?: string;
    defaultChannel: string;
  };
  scheduleIntervalMs?: number;
}

function loadAppConfig(): AppConfig {
  const mode = parseMode(
    process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1],
  );

  const configPath = resolve(
    process.env.INVARIANTS_CONFIG ?? "invariants.json",
  );

  return {
    mode,
    configPath,
    sourcegraph: {
      instanceUrl: requireEnv("SOURCEGRAPH_URL"),
      accessToken: requireEnv("SOURCEGRAPH_TOKEN"),
    },
    slack:
      mode === "server"
        ? {
            botToken: requireEnv("SLACK_BOT_TOKEN"),
            signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
            appToken: process.env.SLACK_APP_TOKEN,
            defaultChannel: process.env.SLACK_CHANNEL ?? "#engineering-alerts",
          }
        : undefined,
    scheduleIntervalMs: parseInt(
      process.env.SCHEDULE_INTERVAL_MS ?? String(7 * 24 * 60 * 60 * 1000), // weekly
      10,
    ),
  };
}

function parseMode(raw?: string): "cli" | "ci" | "server" {
  if (raw === "cli" || raw === "ci" || raw === "server") return raw;
  // Auto-detect: if running in GitHub Actions, use CI mode
  if (process.env.GITHUB_ACTIONS === "true") return "ci";
  return "cli";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadAppConfig();
  console.log(`[Invariant Verifier] Mode: ${config.mode}`);

  const sg = new SourcegraphClient({
    instanceUrl: config.sourcegraph.instanceUrl,
    accessToken: config.sourcegraph.accessToken,
    maxTurns: 12,
  });

  const engine = new InvariantEngine(sg);
  const invariants = await engine.loadConfig(config.configPath);
  console.log(
    `[Invariant Verifier] Loaded ${invariants.invariants.length} invariants`,
  );

  switch (config.mode) {
    case "cli":
      await runCLI(engine, invariants);
      break;
    case "ci":
      await runCI(engine, invariants);
      break;
    case "server":
      await runServer(engine, invariants, config);
      break;
  }
}

// ---------------------------------------------------------------------------
// Mode: CLI
// ---------------------------------------------------------------------------

async function runCLI(
  engine: InvariantEngine,
  config: ReturnType<
    typeof InvariantEngine.prototype.loadConfig
  > extends Promise<infer T>
    ? T
    : never,
): Promise<void> {
  const summary = await engine.verifyAll(config);

  console.log("\n=== Verification Results ===");
  console.log(`Checked: ${summary.totalInvariants}`);
  console.log(`Passed:  ${summary.passed}`);
  console.log(`Failed:  ${summary.failed}`);
  console.log(`Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);

  if (summary.violations.length > 0) {
    console.log("\nViolations:");
    for (const v of summary.violations) {
      console.log(
        `  [${v.severity.toUpperCase()}] ${v.invariantId} in ${v.repo}`,
      );
      console.log(`    ${v.message}`);
    }
  }

  process.exit(exitCodeForSummary(summary));
}

// ---------------------------------------------------------------------------
// Mode: CI
// ---------------------------------------------------------------------------

async function runCI(
  engine: InvariantEngine,
  config: ReturnType<
    typeof InvariantEngine.prototype.loadConfig
  > extends Promise<infer T>
    ? T
    : never,
): Promise<void> {
  const ci = detectCIContext();
  const summary = await engine.verifyAll(config);

  // Always log to stdout
  console.log(formatPRComment(summary));

  // Post as PR comment if we have the context
  if (ci.triggerType === "pr" && ci.prNumber && ci.repo && ci.githubToken) {
    const [owner, repo] = ci.repo.split("/");
    await postPRComment({
      owner,
      repo,
      prNumber: ci.prNumber,
      body: formatPRComment(summary),
      token: ci.githubToken,
    });
  }

  process.exit(exitCodeForSummary(summary));
}

// ---------------------------------------------------------------------------
// Mode: Server (Slack bot + scheduled scans)
// ---------------------------------------------------------------------------

async function runServer(
  engine: InvariantEngine,
  invariantsConfig: ReturnType<
    typeof InvariantEngine.prototype.loadConfig
  > extends Promise<infer T>
    ? T
    : never,
  appConfig: AppConfig,
): Promise<void> {
  if (!appConfig.slack) {
    throw new Error("Slack config required for server mode");
  }

  const slack = new SlackNotifier(appConfig.slack);

  // Handle @mention triggers
  slack.onVerifyCommand(async (channel, threadTs) => {
    console.log(`[Server] Triggered verification from Slack in ${channel}`);
    const summary = await engine.verifyAll(invariantsConfig);
    await slack.postSummary(summary, channel);
  });

  // Scheduled scans
  const intervalMs = appConfig.scheduleIntervalMs ?? 7 * 24 * 60 * 60 * 1000;
  console.log(
    `[Server] Scheduling scans every ${(intervalMs / 1000 / 60 / 60).toFixed(1)} hours`,
  );

  const runScheduledScan = async () => {
    console.log(`[Server] Running scheduled scan`);
    try {
      const summary = await engine.verifyAll(invariantsConfig);
      await slack.postSummary(summary);
    } catch (err) {
      console.error("[Server] Scheduled scan failed:", err);
    }
  };

  setInterval(runScheduledScan, intervalMs);

  await slack.start();
  console.log("[Server] Invariant Verifier running");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("[Fatal]", err);
  process.exit(2);
});
