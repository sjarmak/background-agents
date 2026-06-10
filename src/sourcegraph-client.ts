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
import { z } from "zod";

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

/** True when results hit the backend's result cap and may be incomplete. */
export interface KeywordSearchResponse {
  matches: RepoMatch[];
  truncated: boolean;
}

export interface RepoSearchResponse {
  matches: Map<string, SearchResult[]>;
  truncated: boolean;
}

export interface SourcegraphSearchClient {
  keywordSearch(
    pattern: string,
    language?: string | null,
  ): Promise<KeywordSearchResponse>;
  searchInRepos(
    repos: string[],
    pattern: string,
  ): Promise<RepoSearchResponse>;
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// GraphQL Client (direct API, no MCP/agent dependency)
// ---------------------------------------------------------------------------

interface GraphQLSearchResult {
  repository: { name: string };
  file: { path: string };
  lineMatches: Array<{ lineNumber: number; preview: string }>;
}

const RESULT_CAP = 500;
const REPO_BATCH_SIZE = 20;

export class SourcegraphGraphQLClient implements SourcegraphSearchClient {
  private readonly config: SourcegraphClientConfig;

  constructor(config: SourcegraphClientConfig) {
    this.config = config;
  }

  async keywordSearch(
    pattern: string,
    language?: string | null,
  ): Promise<KeywordSearchResponse> {
    const langFilter = language ? ` lang:${language}` : "";
    const { results, truncated } = await this.search(
      `${pattern}${langFilter} count:${RESULT_CAP}`,
    );
    return { matches: groupByRepo(results), truncated };
  }

  /**
   * Pre-flight health check — issues a minimal GraphQL query to verify the
   * Sourcegraph instance is reachable and the access token is valid. Throws
   * on any connection, HTTP, GraphQL, or auth failure so callers can exit
   * with a distinct non-violation exit code.
   */
  async healthCheck(): Promise<{ username: string | null }> {
    const graphqlQuery = `query HealthCheck { currentUser { username } }`;

    let response: Response;
    try {
      response = await fetch(`${this.config.instanceUrl}/.api/graphql`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `token ${this.config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: graphqlQuery }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Sourcegraph pre-flight connection failed: ${msg}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Sourcegraph pre-flight auth failed: ${response.status} ${response.statusText}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Sourcegraph pre-flight HTTP error: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      data?: { currentUser?: { username: string } | null };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(
        `Sourcegraph pre-flight GraphQL error: ${json.errors[0].message}`,
      );
    }

    return { username: json.data?.currentUser?.username ?? null };
  }

  async searchInRepos(
    repos: string[],
    pattern: string,
  ): Promise<RepoSearchResponse> {
    if (repos.length === 0) return { matches: new Map(), truncated: false };

    // Batch repos into alternation filters (repo:^(a|b|...)$) so N repos cost
    // ceil(N / REPO_BATCH_SIZE) queries instead of one oversized query.
    const all: SearchResult[] = [];
    let truncated = false;
    for (let i = 0; i < repos.length; i += REPO_BATCH_SIZE) {
      const batch = repos.slice(i, i + REPO_BATCH_SIZE);
      const alternation = batch.map(escapeRegex).join("|");
      const queryStr = `${pattern} repo:^(${alternation})$ count:${RESULT_CAP}`;
      const { results, truncated: batchTruncated } =
        await this.search(queryStr);
      all.push(...results);
      truncated = truncated || batchTruncated;
    }
    return { matches: groupResultsByRepo(all), truncated };
  }

  private async search(
    queryStr: string,
  ): Promise<{ results: SearchResult[]; truncated: boolean }> {
    // Retry once after 5s on HTTP 5xx. Two consecutive 5xx = real outage.
    try {
      return await this.searchOnce(queryStr);
    } catch (err) {
      if (err instanceof Error && /^Sourcegraph API error: 5\d\d/.test(err.message)) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return await this.searchOnce(queryStr);
      }
      throw err;
    }
  }

  private async searchOnce(
    queryStr: string,
  ): Promise<{ results: SearchResult[]; truncated: boolean }> {
    const graphqlQuery = `
      query Search($query: String!) {
        search(query: $query) {
          results {
            limitHit
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
          results?: { limitHit?: boolean; results?: GraphQLSearchResult[] };
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

    // limitHit is Sourcegraph's authoritative truncation signal; the count
    // comparison is a fallback for backends that omit it. count: caps
    // line-level matches, so compare the flattened results, not FileMatch nodes.
    const truncated =
      json.data?.search?.results?.limitHit === true ||
      results.length >= RESULT_CAP;
    if (truncated) {
      console.error(
        `[sourcegraph] Warning: result count hit cap (${RESULT_CAP}) for query: ${queryStr} — results may be truncated`,
      );
    }

    return { results, truncated };
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

const AgentSearchResultSchema = z.object({
  repo: z.string(),
  file: z.string(),
  lineNumber: z.number(),
  content: z.string(),
  language: z.string(),
});

const AgentSearchResultsSchema = z.array(AgentSearchResultSchema);

export class SourcegraphMCPClient implements SourcegraphSearchClient {
  private readonly config: SourcegraphClientConfig;

  constructor(config: SourcegraphClientConfig) {
    this.config = config;
  }

  async keywordSearch(
    pattern: string,
    language?: string | null,
  ): Promise<KeywordSearchResponse> {
    const languageFilter = language ? ` language:${language}` : "";
    const prompt = [
      `Use the keyword_search tool to search for the pattern: ${pattern}${languageFilter}`,
      "Return ONLY a JSON array of objects with fields: repo, file, lineNumber, content, language.",
      "No explanation, just the JSON array.",
    ].join("\n");

    const results = await this.runAgent(prompt);
    return { matches: groupByRepo(results), truncated: false };
  }

  async searchInRepos(
    repos: string[],
    pattern: string,
  ): Promise<RepoSearchResponse> {
    const repoFilter = repos.map((r) => `repo:${r}`).join(" OR ");
    const prompt = [
      `Use the keyword_search tool to search for: ${pattern} in repos matching (${repoFilter})`,
      "Return ONLY a JSON array of objects with fields: repo, file, lineNumber, content, language.",
      "No explanation, just the JSON array.",
    ].join("\n");

    const results = await this.runAgent(prompt);
    return { matches: groupResultsByRepo(results), truncated: false };
  }

  /**
   * Run the agent and parse its final message as a validated search result
   * array. Throws on any extraction, parse, or schema failure — a mumbled
   * agent response must surface as an error, never as "no matches".
   */
  private async runAgent(prompt: string): Promise<SearchResult[]> {
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
      throw new Error("MCP agent produced no assistant message");
    }

    const content = lastAssistant.message.content;
    const text = Array.isArray(content)
      ? content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { type: string; text?: string }) => b.text ?? "")
          .join("")
      : String(content);

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error(
        `MCP agent response contained no JSON array: ${text.slice(0, 200)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `MCP agent response is not valid JSON (${msg}): ${jsonMatch[0].slice(0, 200)}`,
      );
    }

    const validated = AgentSearchResultsSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `MCP agent response failed schema validation: ${validated.error.message}`,
      );
    }

    return validated.data;
  }
}
