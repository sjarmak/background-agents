/**
 * Slack integration for posting invariant verification results.
 *
 * Reusable by Week 2-3 agents. Supports:
 * - Posting violation reports to a channel
 * - Threaded replies for detailed per-invariant results
 * - Receiving @mention triggers for on-demand scans
 */

import { App, type Block, type KnownBlock } from "@slack/bolt";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Violation {
  invariantId: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  repo: string;
  message: string;
  details?: string;
}

export interface VerificationSummary {
  totalInvariants: number;
  passed: number;
  failed: number;
  violations: Violation[];
  durationMs: number;
}

export interface SlackNotifierConfig {
  botToken: string;
  signingSecret: string;
  appToken?: string; // For socket mode
  defaultChannel: string;
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

export class SlackNotifier {
  private readonly app: App;
  private readonly defaultChannel: string;

  constructor(config: SlackNotifierConfig) {
    this.defaultChannel = config.defaultChannel;

    this.app = new App({
      token: config.botToken,
      signingSecret: config.signingSecret,
      ...(config.appToken
        ? { socketMode: true, appToken: config.appToken }
        : {}),
    });
  }

  /**
   * Post a verification summary to Slack.
   * Returns the thread timestamp for follow-up messages.
   */
  async postSummary(
    summary: VerificationSummary,
    channel?: string,
  ): Promise<string | undefined> {
    const target = channel ?? this.defaultChannel;
    const icon = summary.failed > 0 ? ":x:" : ":white_check_mark:";
    const statusText =
      summary.failed > 0
        ? `${summary.failed} invariant violation(s) detected`
        : "All invariants verified successfully";

    const blocks: (Block | KnownBlock)[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${icon} Cross-Repo Invariant Check`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*${statusText}*`,
            "",
            `• Invariants checked: ${summary.totalInvariants}`,
            `• Passed: ${summary.passed}`,
            `• Failed: ${summary.failed}`,
            `• Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
          ].join("\n"),
        },
      },
    ];

    // Add violation details inline for small counts
    if (summary.violations.length > 0 && summary.violations.length <= 5) {
      for (const v of summary.violations) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              `*[${v.severity.toUpperCase()}] ${v.invariantId}*`,
              `Repo: \`${v.repo}\``,
              v.message,
            ].join("\n"),
          },
        });
      }
    }

    const result = await this.app.client.chat.postMessage({
      channel: target,
      text: statusText,
      blocks,
    });

    // For large violation counts, post details in thread
    if (summary.violations.length > 5 && result.ts) {
      await this.postViolationThread(target, result.ts, summary.violations);
    }

    return result.ts;
  }

  /**
   * Post detailed violations as threaded replies.
   */
  private async postViolationThread(
    channel: string,
    threadTs: string,
    violations: Violation[],
  ): Promise<void> {
    // Group by severity for readability
    const bySeverity = new Map<string, Violation[]>();
    for (const v of violations) {
      const group = bySeverity.get(v.severity) ?? [];
      group.push(v);
      bySeverity.set(v.severity, group);
    }

    for (const [severity, group] of bySeverity) {
      const lines = group.map(
        (v) => `• *${v.invariantId}* in \`${v.repo}\`: ${v.message}`,
      );

      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `${severity.toUpperCase()} violations`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${severity.toUpperCase()} (${group.length})*\n${lines.join("\n")}`,
            },
          },
        ],
      });
    }
  }

  /**
   * Register a handler for @mention triggers.
   * When someone mentions the bot with "verify invariants", run a scan.
   */
  onVerifyCommand(
    handler: (channel: string, threadTs?: string) => Promise<void>,
  ): void {
    this.app.event("app_mention", async ({ event }) => {
      const text = event.text.toLowerCase();
      if (
        text.includes("verify") ||
        text.includes("invariant") ||
        text.includes("check")
      ) {
        await handler(event.channel, event.thread_ts ?? event.ts);
      }
    });
  }

  /**
   * Start the Slack app (socket mode or HTTP).
   */
  async start(port?: number): Promise<void> {
    await this.app.start(port ?? 3000);
    console.log("[SlackNotifier] Listening for events");
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}
