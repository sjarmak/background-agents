/**
 * Main entry point for the Cross-Repo Invariant Verifier.
 *
 * Two modes, accepted for compatibility but behaviorally identical:
 *   --mode=cli   One-shot verification (local runs, `npm run verify`)
 *   --mode=ci    Same verification under GitHub Actions
 *
 * Both print the JSON report to stdout and exit per exitCodeForReport()
 * (0 = clean, 1 = blocking violations, 2 = infrastructure failure). PR
 * comment posting lives in the PR workflow's marker-upsert step, not here.
 *
 * Server mode (Slack Bolt bot) removed — scheduled Slack output uses
 * B's curl-to-webhook approach via post-slack.sh in the GitHub Action.
 */

import {
  SourcegraphGraphQLClient,
  SourcegraphMCPClient,
} from "./sourcegraph-client.js";
import { InvariantEngine } from "./invariant-engine.js";
import { exitCodeForReport } from "./ci-trigger.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface AppConfig {
  mode: "cli" | "ci";
  backend: "graphql" | "mcp";
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
  const backend = process.argv.includes("--mcp") ? "mcp" : "graphql";
  const configPath = resolve(
    process.argv.find((a) => a.startsWith("--config="))?.split("=")[1] ??
      process.env.INVARIANTS_CONFIG ??
      "config/invariants.json",
  );

  if (!existsSync(configPath)) {
    console.error(`[verifier] Invariants config file not found: ${configPath}`);
    process.exit(2);
  }

  return {
    mode,
    backend,
    configPath,
    sourcegraph: {
      instanceUrl: requireEnv("SOURCEGRAPH_URL"),
      accessToken: requireEnv("SRC_ACCESS_TOKEN"),
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

  const sgConfig = {
    instanceUrl: config.sourcegraph.instanceUrl,
    accessToken: config.sourcegraph.accessToken,
  };
  const sg =
    config.backend === "mcp"
      ? new SourcegraphMCPClient({ ...sgConfig, maxTurns: 12 })
      : new SourcegraphGraphQLClient(sgConfig);

  // Pre-flight health check (GraphQL backend only). On failure, exit with
  // code 2 to distinguish connection/auth issues from invariant violations
  // (code 1). CI consumers can then post a "Sourcegraph unreachable" comment
  // instead of treating this as a hard failure.
  if (sg instanceof SourcegraphGraphQLClient) {
    try {
      const health = await sg.healthCheck();
      console.error(
        `[verifier] Sourcegraph pre-flight OK (user: ${health.username ?? "anonymous"})`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[verifier] ${msg}`);
      process.exit(2);
    }
  }

  const engine = new InvariantEngine(sg);
  const invariants = await engine.loadConfig(config.configPath);
  console.error(`[verifier] Loaded ${invariants.invariants.length} invariants`);

  const report = await engine.verifyAll(invariants);

  // JSON to stdout (consumable by post-slack.sh and the PR workflow's
  // marker-upsert comment step) — identical in cli and ci modes.
  console.log(JSON.stringify(report, null, 2));

  process.exit(exitCodeForReport(report));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(2);
});
