/**
 * Reusable Sourcegraph MCP client.
 *
 * Wraps Claude Agent SDK invocations with the Sourcegraph MCP server.
 * Designed for reuse by future agents (Merge Conflict Predictor,
 * Dependency Impact Oracle).
 *
 * Origin: Parent C (agent-sdk-service), kept as-is for reusability.
 */

import { query, type ClaudeCodeOptions } from "@anthropic-ai/claude-code";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  repo: string;
  file: string;
  lineNumber: number;
  content: string;
  language: string;
}

export interface RepoMatch {
  repo: string;
  files: SearchResult[];
}

export interface SourcegraphClientConfig {
  /** Sourcegraph instance URL (e.g. https://sourcegraph.example.com) */
  instanceUrl: string;
  /** Sourcegraph access token */
  accessToken: string;
  /** Max agent turns per query (safety rail) */
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// MCP server configuration
// ---------------------------------------------------------------------------

function buildMcpConfig(config: SourcegraphClientConfig) {
  return {
    sourcegraph: {
      command: "npx",
      args: ["-y", "mcp-remote", `${config.instanceUrl}/.api/mcp`],
      env: {
        SRC_ACCESS_TOKEN: config.accessToken,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SourcegraphClient {
  private readonly config: SourcegraphClientConfig;

  constructor(config: SourcegraphClientConfig) {
    this.config = config;
  }

  /**
   * Run a keyword search across all repos via the Sourcegraph MCP.
   */
  async keywordSearch(
    pattern: string,
    language?: string | null,
  ): Promise<RepoMatch[]> {
    const languageFilter = language ? ` language:${language}` : "";
    const prompt = [
      `Use the keyword_search tool to search for the pattern: ${pattern}${languageFilter}`,
      "Return ONLY a JSON array of objects with fields: repo, file, lineNumber, content, language.",
      "No explanation, just the JSON array.",
    ].join("\n");

    return this.runAgent<RepoMatch[]>(prompt, (raw) =>
      this.groupByRepo(raw as SearchResult[]),
    );
  }

  /**
   * Search for a pattern within specific repos.
   * Used for assertion checking (e.g., "repos that import X must also contain Y").
   */
  async searchInRepos(
    repos: string[],
    pattern: string,
  ): Promise<Map<string, SearchResult[]>> {
    const repoFilter = repos.map((r) => `repo:${r}`).join(" OR ");
    const prompt = [
      `Use the keyword_search tool to search for: ${pattern} in repos matching (${repoFilter})`,
      "Return ONLY a JSON array of objects with fields: repo, file, lineNumber, content, language.",
      "No explanation, just the JSON array.",
    ].join("\n");

    const results = await this.runAgent<SearchResult[]>(prompt, (raw) =>
      Array.isArray(raw) ? (raw as SearchResult[]) : [],
    );

    const byRepo = new Map<string, SearchResult[]>();
    for (const r of results) {
      const existing = byRepo.get(r.repo) ?? [];
      existing.push(r);
      byRepo.set(r.repo, existing);
    }
    return byRepo;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async runAgent<T>(
    prompt: string,
    transform: (raw: unknown) => T,
  ): Promise<T> {
    const options: ClaudeCodeOptions = {
      prompt,
      options: {
        maxTurns: this.config.maxTurns ?? 10,
        allowedTools: [
          "mcp__sourcegraph__keyword_search",
          "mcp__sourcegraph__find_references",
          "mcp__sourcegraph__get_file_content",
        ],
      },
      mcpServers: buildMcpConfig(this.config),
    };

    const messages = await query(options);

    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");

    if (!lastAssistant) {
      return transform([]);
    }

    const text =
      typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : lastAssistant.content
            .filter((b: { type: string }) => b.type === "text")
            .map((b: { type: string; text?: string }) => b.text ?? "")
            .join("");

    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      return transform(parsed);
    } catch {
      console.error(
        "Failed to parse agent response as JSON:",
        text.slice(0, 200),
      );
      return transform([]);
    }
  }

  private groupByRepo(results: SearchResult[]): RepoMatch[] {
    if (!Array.isArray(results)) return [];
    const grouped = new Map<string, SearchResult[]>();
    for (const r of results) {
      const existing = grouped.get(r.repo) ?? [];
      existing.push(r);
      grouped.set(r.repo, existing);
    }
    return Array.from(grouped.entries()).map(([repo, files]) => ({
      repo,
      files,
    }));
  }
}
