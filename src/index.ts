/**
 * Main entry point for the Cross-Repo Invariant Verifier.
 *
 * Two modes:
 *   --mode=cli   One-shot verification, prints JSON report to stdout, exits
 *   --mode=ci    CI mode — detects GitHub Actions context, posts PR comment
 *
 * Server mode (Slack Bolt bot) removed — scheduled Slack output uses
 * B's curl-to-webhook approach via post-slack.sh in the GitHub Action.
 */

import { SourcegraphClient } from "./sourcegraph-client.js";
import { InvariantEngine } from "./invariant-engine.js";
import {
  detectCIContext,
  formatPRComment,
  postPRComment,
  exitCodeForReport,
} from "./ci-trigger.js";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface AppConfig {
  mode: "cli" | "ci";
  configPath: string;
  sourcegraph: {
    instanceUrl: string;
    accessToken: string;
  };
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
  };
}

function parseMode(raw?: string): "cli" | "ci" {
  if (raw === "cli" || raw === "ci") return raw;
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
  console.error(`[verifier] Mode: ${config.mode}`);

  const sg = new SourcegraphClient({
    instanceUrl: config.sourcegraph.instanceUrl,
    accessToken: config.sourcegraph.accessToken,
    maxTurns: 12,
  });

  const engine = new InvariantEngine(sg);
  const invariants = await engine.loadConfig(config.configPath);
  console.error(
    `[verifier] Loaded ${invariants.invariants.length} invariants`,
  );

  switch (config.mode) {
    case "cli":
      await runCLI(engine, invariants);
      break;
    case "ci":
      await runCI(engine, invariants);
      break;
  }
}

// ---------------------------------------------------------------------------
// Mode: CLI — outputs B's JSON report contract to stdout
// ---------------------------------------------------------------------------

async function runCLI(
  engine: InvariantEngine,
  config: Awaited<ReturnType<InvariantEngine["loadConfig"]>>,
): Promise<void> {
  const report = await engine.verifyAll(config);

  // JSON to stdout (consumable by post-slack.sh, post-github-comment.sh)
  console.log(JSON.stringify(report, null, 2));

  process.exit(exitCodeForReport(report));
}

// ---------------------------------------------------------------------------
// Mode: CI — posts PR comment, outputs JSON
// ---------------------------------------------------------------------------

async function runCI(
  engine: InvariantEngine,
  config: Awaited<ReturnType<InvariantEngine["loadConfig"]>>,
): Promise<void> {
  const ci = detectCIContext();
  const report = await engine.verifyAll(config);

  // Always write JSON to stdout
  console.log(JSON.stringify(report, null, 2));

  // Post PR comment if we have the context
  if (ci.triggerType === "pr" && ci.prNumber && ci.repo && ci.githubToken) {
    const [owner, repo] = ci.repo.split("/");
    await postPRComment({
      owner,
      repo,
      prNumber: ci.prNumber,
      body: formatPRComment(report),
      token: ci.githubToken,
    });
  }

  process.exit(exitCodeForReport(report));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(2);
});
