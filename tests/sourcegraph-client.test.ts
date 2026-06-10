import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-code";
import {
  SourcegraphGraphQLClient,
  SourcegraphMCPClient,
  type SearchResult,
} from "../src/sourcegraph-client.js";

vi.mock("@anthropic-ai/claude-code", () => ({ query: vi.fn() }));

const clientConfig = {
  instanceUrl: "https://sg.example.com",
  accessToken: "secret-token",
};

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: { "Content-Type": "application/json" },
  });
}

interface GraphQLFileMatch {
  repository: { name: string } | null;
  file: { path: string } | null;
  lineMatches: Array<{ lineNumber: number; preview: string }>;
}

function searchBody(matches: GraphQLFileMatch[], limitHit = false): unknown {
  return { data: { search: { results: { limitHit, results: matches } } } };
}

function fileMatch(
  repo: string,
  file: string,
  lines: Array<{ lineNumber: number; preview: string }>,
): GraphQLFileMatch {
  return { repository: { name: repo }, file: { path: file }, lineMatches: lines };
}

function sentQuery(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  const body = JSON.parse(
    (fetchMock.mock.calls[call][1] as RequestInit).body as string,
  ) as { variables: { query: string } };
  return body.variables.query;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(query).mockReset();
});

describe("SourcegraphGraphQLClient.keywordSearch", () => {
  it("sends the auth header and a search GraphQL query with the result cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(searchBody([])));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await client.keywordSearch("fetchUser");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sg.example.com/.api/graphql");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "token secret-token",
    );
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: { query: string };
    };
    expect(body.query).toContain("search(query: $query)");
    expect(body.query).toContain("FileMatch");
    expect(body.variables.query).toBe("fetchUser count:500");
  });

  it("appends a lang filter when a language is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(searchBody([])));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await client.keywordSearch("fetchUser", "go");

    expect(sentQuery(fetchMock)).toBe("fetchUser lang:go count:500");
  });

  it("groups line matches by repo and skips matches without repo or file", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        searchBody([
          fileMatch("acme/api", "src/a.ts", [
            { lineNumber: 3, preview: "foo" },
            { lineNumber: 9, preview: "bar" },
          ]),
          fileMatch("acme/web", "src/b.ts", [{ lineNumber: 1, preview: "baz" }]),
          { repository: null, file: null, lineMatches: [] },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    const { matches, truncated } = await client.keywordSearch("x");

    expect(truncated).toBe(false);
    expect(matches).toEqual([
      {
        repo: "acme/api",
        files: [
          { repo: "acme/api", file: "src/a.ts", lineNumber: 3, content: "foo", language: "" },
          { repo: "acme/api", file: "src/a.ts", lineNumber: 9, content: "bar", language: "" },
        ],
      },
      {
        repo: "acme/web",
        files: [
          { repo: "acme/web", file: "src/b.ts", lineNumber: 1, content: "baz", language: "" },
        ],
      },
    ]);
  });

  it("sets the truncated flag when the result count hits the cap", async () => {
    const capped = Array.from({ length: 500 }, (_, i) =>
      fileMatch("acme/api", `src/f${i}.ts`, [{ lineNumber: 1, preview: "p" }]),
    );
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(searchBody(capped)));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    const { truncated } = await client.keywordSearch("x");

    expect(truncated).toBe(true);
  });

  it("requests limitHit and sets the truncated flag when it is true despite few file matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        searchBody(
          [fileMatch("acme/api", "a.ts", [{ lineNumber: 1, preview: "p" }])],
          true,
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    const { truncated } = await client.keywordSearch("x");

    expect(truncated).toBe(true);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { query: string };
    expect(body.query).toContain("limitHit");
  });

  it("sets the truncated flag when line-level matches hit the cap across fewer files", async () => {
    const lines = Array.from({ length: 5 }, (_, j) => ({
      lineNumber: j + 1,
      preview: "p",
    }));
    const capped = Array.from({ length: 100 }, (_, i) =>
      fileMatch("acme/api", `src/f${i}.ts`, lines),
    );
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(searchBody(capped)));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    const { truncated } = await client.keywordSearch("x");

    expect(truncated).toBe(true);
  });

  it("retries exactly once on a 5xx and then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({}, { status: 500, statusText: "Internal Server Error" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          searchBody([fileMatch("acme/api", "a.ts", [{ lineNumber: 1, preview: "p" }])]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    const promise = client.keywordSearch("x");
    await vi.advanceTimersByTimeAsync(5_000);
    const { matches } = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(matches).toHaveLength(1);
  });

  it("retries exactly once on a 5xx and surfaces the second failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({}, { status: 500, statusText: "Internal Server Error" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({}, { status: 503, statusText: "Service Unavailable" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    const promise = client.keywordSearch("x");
    const expectation = expect(promise).rejects.toThrow(
      "Sourcegraph API error: 503 Service Unavailable",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 and surfaces the auth error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({}, { status: 401, statusText: "Unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await expect(client.keywordSearch("x")).rejects.toThrow(
      "Sourcegraph API error: 401 Unauthorized",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces GraphQL-level errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: "bad query" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await expect(client.keywordSearch("x")).rejects.toThrow(
      "Sourcegraph GraphQL error: bad query",
    );
  });
});

describe("SourcegraphGraphQLClient.searchInRepos", () => {
  it("returns immediately without fetching when given no repos", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    const { matches, truncated } = await client.searchInRepos([], "p");

    expect(matches.size).toBe(0);
    expect(truncated).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds an escaped repo alternation filter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(searchBody([])));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await client.searchInRepos(
      ["github.com/acme/api", "github.com/acme/web"],
      "init()",
    );

    expect(sentQuery(fetchMock)).toBe(
      "init() repo:^(github\\.com/acme/api|github\\.com/acme/web)$ count:500",
    );
  });

  it("batches repos 20 per query and merges grouped results", async () => {
    const repos = Array.from({ length: 25 }, (_, i) => `acme/r${i}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          searchBody([fileMatch("acme/r0", "a.ts", [{ lineNumber: 1, preview: "p" }])]),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          searchBody([fileMatch("acme/r24", "b.ts", [{ lineNumber: 2, preview: "q" }])]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    const { matches, truncated } = await client.searchInRepos(repos, "p");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentQuery(fetchMock, 0)).toContain(`repo:^(${repos.slice(0, 20).join("|")})$`);
    expect(sentQuery(fetchMock, 1)).toContain(`repo:^(${repos.slice(20).join("|")})$`);
    expect(truncated).toBe(false);
    expect([...matches.keys()]).toEqual(["acme/r0", "acme/r24"]);
  });

  it("ORs truncation flags across batches", async () => {
    const repos = Array.from({ length: 21 }, (_, i) => `acme/r${i}`);
    const capped = Array.from({ length: 500 }, (_, i) =>
      fileMatch("acme/r0", `f${i}.ts`, [{ lineNumber: 1, preview: "p" }]),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(searchBody(capped)))
      .mockResolvedValueOnce(jsonResponse(searchBody([])));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    const { truncated } = await client.searchInRepos(repos, "p");

    expect(truncated).toBe(true);
  });
});

describe("SourcegraphGraphQLClient.healthCheck", () => {
  it("returns the username on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { currentUser: { username: "alice" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await expect(client.healthCheck()).resolves.toEqual({ username: "alice" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sg.example.com/.api/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "token secret-token",
    );
  });

  it("returns a null username for anonymous access", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { currentUser: null } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await expect(client.healthCheck()).resolves.toEqual({ username: null });
  });

  it("throws a connection error when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const client = new SourcegraphGraphQLClient(clientConfig);

    await expect(client.healthCheck()).rejects.toThrow(
      "Sourcegraph pre-flight connection failed: ECONNREFUSED",
    );
  });

  it.each([401, 403])("throws an auth error on %d", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({}, { status, statusText: "Denied" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await expect(client.healthCheck()).rejects.toThrow(
      `Sourcegraph pre-flight auth failed: ${status} Denied`,
    );
  });

  it("throws an HTTP error on other non-OK statuses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({}, { status: 502, statusText: "Bad Gateway" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await expect(client.healthCheck()).rejects.toThrow(
      "Sourcegraph pre-flight HTTP error: 502 Bad Gateway",
    );
  });

  it("throws on GraphQL-level errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: "token expired" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SourcegraphGraphQLClient(clientConfig);

    await expect(client.healthCheck()).rejects.toThrow(
      "Sourcegraph pre-flight GraphQL error: token expired",
    );
  });
});

// ---------------------------------------------------------------------------
// MCP client (query() mocked at the module boundary)
// ---------------------------------------------------------------------------

type AgentMessage =
  | { type: "assistant"; message: { content: unknown } }
  | { type: "system" };

function mockAgentMessages(messages: AgentMessage[]): void {
  vi.mocked(query).mockReturnValue(
    (async function* () {
      yield* messages;
    })() as unknown as ReturnType<typeof query>,
  );
}

function assistantText(text: string): AgentMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

const agentResult: SearchResult = {
  repo: "acme/api",
  file: "src/a.ts",
  lineNumber: 4,
  content: "needle",
  language: "typescript",
};

describe("SourcegraphMCPClient", () => {
  it("keywordSearch parses a valid JSON array from the agent and groups by repo", async () => {
    mockAgentMessages([assistantText(`Here you go: ${JSON.stringify([agentResult])}`)]);
    const client = new SourcegraphMCPClient(clientConfig);

    const { matches, truncated } = await client.keywordSearch("needle", "typescript");

    expect(truncated).toBe(false);
    expect(matches).toEqual([{ repo: "acme/api", files: [agentResult] }]);
    const promptArg = vi.mocked(query).mock.calls[0][0] as { prompt: string };
    expect(promptArg.prompt).toContain("needle language:typescript");
  });

  it("searchInRepos returns results keyed by repo", async () => {
    mockAgentMessages([assistantText(JSON.stringify([agentResult]))]);
    const client = new SourcegraphMCPClient(clientConfig);

    const { matches, truncated } = await client.searchInRepos(["acme/api"], "needle");

    expect(truncated).toBe(false);
    expect(matches.get("acme/api")).toEqual([agentResult]);
  });

  it("uses the last assistant message and string content", async () => {
    mockAgentMessages([
      assistantText("intermediate thinking"),
      { type: "system" },
      { type: "assistant", message: { content: JSON.stringify([agentResult]) } },
    ]);
    const client = new SourcegraphMCPClient(clientConfig);

    const { matches } = await client.keywordSearch("needle");

    expect(matches).toHaveLength(1);
  });

  it("throws when the agent produces no assistant message", async () => {
    mockAgentMessages([{ type: "system" }]);
    const client = new SourcegraphMCPClient(clientConfig);

    await expect(client.keywordSearch("needle")).rejects.toThrow(
      "MCP agent produced no assistant message",
    );
  });

  it("throws when the response contains no JSON array", async () => {
    mockAgentMessages([assistantText("I could not find anything, sorry!")]);
    const client = new SourcegraphMCPClient(clientConfig);

    await expect(client.keywordSearch("needle")).rejects.toThrow(
      "MCP agent response contained no JSON array",
    );
  });

  it("throws when the extracted array is not valid JSON", async () => {
    mockAgentMessages([assistantText("[{repo: missing-quotes}]")]);
    const client = new SourcegraphMCPClient(clientConfig);

    await expect(client.keywordSearch("needle")).rejects.toThrow(
      "MCP agent response is not valid JSON",
    );
  });

  it("throws when the array fails schema validation", async () => {
    mockAgentMessages([assistantText(JSON.stringify([{ repo: 42 }]))]);
    const client = new SourcegraphMCPClient(clientConfig);

    await expect(client.searchInRepos(["acme/api"], "needle")).rejects.toThrow(
      "MCP agent response failed schema validation",
    );
  });
});
