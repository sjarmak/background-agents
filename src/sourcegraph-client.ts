/**
 * Reusable Sourcegraph client.
 *
 * Two backends:
 *   - SourcegraphGraphQLClient: Direct GraphQL API (reliable, token-based auth)
 *   - SourcegraphMCPClient: Claude Agent SDK + MCP (for interactive agent use)
 *
 * Both implement the same interface so InvariantEngine works with either.
 */

import {
  query,
  type SDKMessage,
  type SDKAssistantMessage,
} from "@anthropic-ai/claude-code";

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

export interface SourcegraphSearchClient {
  keywordSearch(
    pattern: string,
    language?: string | null,
  ): Promise<RepoMatch[]>;
  searchInRepos(
    repos: string[],
    pattern: string,
  ): Promise<Map<string, SearchResult[]>>;
}

export interface SourcegraphClientConfig {
  /** Sourcegraph instance URL (e.g. https://sourcegraph.example.com) */
  instanceUrl: string;
  /** Sourcegraph access token */
  accessToken: string;
  /** Max agent turns per query (safety rail, MCP client only) */
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function groupResultsByRepo(
  results: SearchResult[],
): Map<string, SearchResult[]> {
  if (!Array.isArray(results)) return new Map();
  const grouped = new Map<string, SearchResult[]>();
  for (const r of results) {
    const existing = grouped.get(r.repo) ?? [];
    existing.push(r);
    grouped.set(r.repo, existing);
  }
  return grouped;
}

function groupByRepo(results: SearchResult[]): RepoMatch[] {
  return Array.from(groupResultsByRepo(results).entries()).map(
    ([repo, files]) => ({ repo, files }),
  );
}

// ---------------------------------------------------------------------------
// GraphQL Client (direct API, no MCP/agent dependency)
// ---------------------------------------------------------------------------

interface GraphQLSearchResult {
  repository: { name: string };
  file: { path: string };
  lineMatches: Array<{ lineNumber: number; preview: string }>;
}

export class SourcegraphGraphQLClient implements SourcegraphSearchClient {
  private readonly config: SourcegraphClientConfig;

  constructor(config: SourcegraphClientConfig) {
    this.config = config;
  }

  async keywordSearch(
    pattern: string,
    language?: string | null,
  ): Promise<RepoMatch[]> {
    const langFilter = language ? ` lang:${language}` : "";
    const results = await this.search(`${pattern}${langFilter} count:100`);
    return groupByRepo(results);
  }

  async searchInRepos(
    repos: string[],
    pattern: string,
  ): Promise<Map<string, SearchResult[]>> {
    if (repos.length === 0) return new Map();
    const repoFilter = repos.map((r) => `repo:^${r}$`).join(" OR ");
    const queryStr = `${pattern} (${repoFilter}) count:100`;
    const results = await this.search(queryStr);
    return groupResultsByRepo(results);
  }

  private async search(queryStr: string): Promise<SearchResult[]> {
    const graphqlQuery = `
      query Search($query: String!) {
        search(query: $query) {
          results {
            results {
              ... on FileMatch {
                repository { name }
                file { path }
                lineMatches { lineNumber preview }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(`${this.config.instanceUrl}/.api/graphql`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `token ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: { query: queryStr },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Sourcegraph API error: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      data?: {
        search?: {
          results?: { results?: GraphQLSearchResult[] };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`Sourcegraph GraphQL error: ${json.errors[0].message}`);
    }

    const matches = json.data?.search?.results?.results ?? [];
    const results: SearchResult[] = [];

    for (const match of matches) {
      if (!match.repository || !match.file) continue;
      for (const line of match.lineMatches ?? []) {
        results.push({
          repo: match.repository.name,
          file: match.file.path,
          lineNumber: line.lineNumber,
          content: line.preview,
          language: "",
        });
      }
    }

    if (matches.length >= 100) {
      console.error(
        `[sourcegraph] Warning: result count hit cap (100) for query: ${queryStr} — results may be truncated`,
      );
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// MCP Client (Claude Agent SDK, for interactive agent use)
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

export class SourcegraphMCPClient implements SourcegraphSearchClient {
  private readonly config: SourcegraphClientConfig;

  constructor(config: SourcegraphClientConfig) {
    this.config = config;
  }

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
      groupByRepo(raw as SearchResult[]),
    );
  }

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
    return groupResultsByRepo(results);
  }

  private async runAgent<T>(
    prompt: string,
    transform: (raw: unknown) => T,
  ): Promise<T> {
    const conversation = query({
      prompt,
      options: {
        maxTurns: this.config.maxTurns ?? 10,
        allowedTools: [
          "mcp__sourcegraph__keyword_search",
          "mcp__sourcegraph__find_references",
          "mcp__sourcegraph__get_file_content",
        ],
        mcpServers: buildMcpConfig(this.config),
      },
    });

    const messages: SDKMessage[] = [];
    for await (const message of conversation) {
      messages.push(message);
    }

    const lastAssistant = [...messages]
      .reverse()
      .find((m): m is SDKAssistantMessage => m.type === "assistant");

    if (!lastAssistant) {
      return transform([]);
    }

    const content = lastAssistant.message.content;
    const text = Array.isArray(content)
      ? content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { type: string; text?: string }) => b.text ?? "")
          .join("")
      : String(content);

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
}
