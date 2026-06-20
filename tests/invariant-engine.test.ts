import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvariantEngine, type Invariant } from "../src/invariant-engine.js";
import type {
  KeywordSearchResponse,
  RepoMatch,
  RepoSearchResponse,
  SearchResult,
  SourcegraphSearchClient,
} from "../src/sourcegraph-client.js";

const TRUNCATION_ERROR =
  "search truncated at result cap; violations may be missed";

function result(repo: string, file: string, lineNumber: number): SearchResult {
  return { repo, file, lineNumber, content: "x", language: "" };
}

function match(repo: string, ...files: SearchResult[]): RepoMatch {
  return { repo, files };
}

function makeInvariant(overrides: Partial<Invariant> = {}): Invariant {
  return {
    id: "inv",
    description: "desc",
    severity: "high",
    search: { pattern: "needle", language: null },
    assertion: { type: "must_not_exist", pattern: null, scope: "repo" },
    message: "msg",
    ...overrides,
  };
}

type KeywordHandler = (
  pattern: string,
  language?: string | null,
) => KeywordSearchResponse | Promise<KeywordSearchResponse>;
type RepoHandler = (
  repos: string[],
  pattern: string,
) => RepoSearchResponse | Promise<RepoSearchResponse>;

class FakeSearchClient implements SourcegraphSearchClient {
  keywordCalls: Array<{ pattern: string; language?: string | null }> = [];
  repoCalls: Array<{ repos: string[]; pattern: string }> = [];

  constructor(
    private readonly onKeyword: KeywordHandler = () => ({
      matches: [],
      truncated: false,
    }),
    private readonly onRepos: RepoHandler = () => ({
      matches: new Map(),
      truncated: false,
    }),
  ) {}

  async keywordSearch(
    pattern: string,
    language?: string | null,
  ): Promise<KeywordSearchResponse> {
    this.keywordCalls.push({ pattern, language });
    return this.onKeyword(pattern, language);
  }

  async searchInRepos(
    repos: string[],
    pattern: string,
  ): Promise<RepoSearchResponse> {
    this.repoCalls.push({ repos, pattern });
    return this.onRepos(repos, pattern);
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyOne: must_not_exist", () => {
  it("reports one violation per matching file with repo/file/line", async () => {
    const client = new FakeSearchClient(() => ({
      matches: [
        match("acme/api", result("acme/api", "src/a.ts", 3)),
        match(
          "acme/web",
          result("acme/web", "lib/b.go", 8),
          result("acme/web", "lib/c.go", 12),
        ),
      ],
      truncated: false,
    }));
    const engine = new InvariantEngine(client);

    const violations = await engine.verifyOne(makeInvariant());

    expect(violations).toEqual([
      {
        repo: "acme/api",
        file: "src/a.ts",
        line: 3,
        detail: "Found deprecated pattern in src/a.ts",
      },
      {
        repo: "acme/web",
        file: "lib/b.go",
        line: 8,
        detail: "Found deprecated pattern in lib/b.go",
      },
      {
        repo: "acme/web",
        file: "lib/c.go",
        line: 12,
        detail: "Found deprecated pattern in lib/c.go",
      },
    ]);
    expect(client.keywordCalls).toEqual([
      { pattern: "needle", language: null },
    ]);
  });

  it("passes when search finds nothing", async () => {
    const client = new FakeSearchClient();
    const engine = new InvariantEngine(client);

    await expect(engine.verifyOne(makeInvariant())).resolves.toEqual([]);
  });
});

describe("verifyOne: must_contain scope=repo", () => {
  const invariant = makeInvariant({
    assertion: { type: "must_contain", pattern: "init()", scope: "repo" },
  });

  it("passes when every matching repo also contains the assertion", async () => {
    const client = new FakeSearchClient(
      () => ({
        matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
        truncated: false,
      }),
      () => ({
        matches: new Map([["acme/api", [result("acme/api", "src/init.ts", 9)]]]),
        truncated: false,
      }),
    );
    const engine = new InvariantEngine(client);

    await expect(engine.verifyOne(invariant)).resolves.toEqual([]);
    expect(client.repoCalls).toEqual([
      { repos: ["acme/api"], pattern: "init()" },
    ]);
  });

  it("reports one violation per repo missing the assertion", async () => {
    const client = new FakeSearchClient(
      () => ({
        matches: [
          match("acme/api", result("acme/api", "src/a.ts", 1)),
          match("acme/web", result("acme/web", "src/b.ts", 2)),
        ],
        truncated: false,
      }),
      () => ({
        matches: new Map([["acme/api", [result("acme/api", "src/init.ts", 9)]]]),
        truncated: false,
      }),
    );
    const engine = new InvariantEngine(client);

    await expect(engine.verifyOne(invariant)).resolves.toEqual([
      {
        repo: "acme/web",
        file: "src/b.ts",
        line: 2,
        detail: "Repo imports pattern but missing required assertion",
      },
    ]);
  });

  it("dedupes repos when multiple files match in the same repo", async () => {
    const client = new FakeSearchClient(
      () => ({
        matches: [
          match("acme/api", result("acme/api", "src/a.ts", 1)),
          match("acme/api", result("acme/api", "src/z.ts", 7)),
          match("acme/web", result("acme/web", "src/b.ts", 2)),
        ],
        truncated: false,
      }),
      () => ({ matches: new Map(), truncated: false }),
    );
    const engine = new InvariantEngine(client);

    const violations = await engine.verifyOne(invariant);

    expect(client.repoCalls).toEqual([
      { repos: ["acme/api", "acme/web"], pattern: "init()" },
    ]);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.repo)).toEqual(["acme/api", "acme/web"]);
  });

  it("returns no violations when the assertion pattern is null", async () => {
    const client = new FakeSearchClient(() => ({
      matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
      truncated: false,
    }));
    const engine = new InvariantEngine(client);
    const nullPattern = makeInvariant({
      assertion: { type: "must_contain", pattern: null, scope: "repo" },
    });

    await expect(engine.verifyOne(nullPattern)).resolves.toEqual([]);
    expect(client.repoCalls).toEqual([]);
  });
});

describe("verifyOne: must_contain scope=file", () => {
  const invariant = makeInvariant({
    assertion: { type: "must_contain", pattern: "init()", scope: "file" },
  });

  it("passes when each matching file contains the assertion", async () => {
    const client = new FakeSearchClient(
      () => ({
        matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
        truncated: false,
      }),
      () => ({
        matches: new Map([["acme/api", [result("acme/api", "src/a.ts", 20)]]]),
        truncated: false,
      }),
    );
    const engine = new InvariantEngine(client);

    await expect(engine.verifyOne(invariant)).resolves.toEqual([]);
  });

  it("reports files where the assertion is absent", async () => {
    const client = new FakeSearchClient(
      () => ({
        matches: [
          match(
            "acme/api",
            result("acme/api", "src/a.ts", 1),
            result("acme/api", "src/b.ts", 5),
          ),
        ],
        truncated: false,
      }),
      () => ({
        matches: new Map([["acme/api", [result("acme/api", "src/a.ts", 20)]]]),
        truncated: false,
      }),
    );
    const engine = new InvariantEngine(client);

    await expect(engine.verifyOne(invariant)).resolves.toEqual([
      {
        repo: "acme/api",
        file: "src/b.ts",
        line: 5,
        detail: "File missing required pattern: init()",
      },
    ]);
  });
});

describe("verifyOne: must_not_contain", () => {
  it("reports each assertion match as a violation (scope=repo)", async () => {
    const client = new FakeSearchClient(
      () => ({
        matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
        truncated: false,
      }),
      () => ({
        matches: new Map([
          [
            "acme/api",
            [
              result("acme/api", "src/db.ts", 14),
              result("acme/api", "src/db2.ts", 3),
            ],
          ],
        ]),
        truncated: false,
      }),
    );
    const engine = new InvariantEngine(client);
    const invariant = makeInvariant({
      assertion: { type: "must_not_contain", pattern: "forbidden", scope: "repo" },
    });

    await expect(engine.verifyOne(invariant)).resolves.toEqual([
      {
        repo: "acme/api",
        file: "src/db.ts",
        line: 14,
        detail: "Found forbidden pattern in src/db.ts",
      },
      {
        repo: "acme/api",
        file: "src/db2.ts",
        line: 3,
        detail: "Found forbidden pattern in src/db2.ts",
      },
    ]);
  });

  it("reports assertion matches as violations (scope=file)", async () => {
    const client = new FakeSearchClient(
      () => ({
        matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
        truncated: false,
      }),
      () => ({
        matches: new Map([["acme/api", [result("acme/api", "src/a.ts", 9)]]]),
        truncated: false,
      }),
    );
    const engine = new InvariantEngine(client);
    const invariant = makeInvariant({
      assertion: { type: "must_not_contain", pattern: "forbidden", scope: "file" },
    });

    await expect(engine.verifyOne(invariant)).resolves.toEqual([
      {
        repo: "acme/api",
        file: "src/a.ts",
        line: 9,
        detail: "Found forbidden pattern in src/a.ts",
      },
    ]);
  });

  it("passes when the assertion pattern is found nowhere", async () => {
    const client = new FakeSearchClient(() => ({
      matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
      truncated: false,
    }));
    const engine = new InvariantEngine(client);
    const invariant = makeInvariant({
      assertion: { type: "must_not_contain", pattern: "forbidden", scope: "repo" },
    });

    await expect(engine.verifyOne(invariant)).resolves.toEqual([]);
  });

  it("short-circuits without an assertion search when the keyword search is empty", async () => {
    const client = new FakeSearchClient();
    const engine = new InvariantEngine(client);
    const invariant = makeInvariant({
      assertion: { type: "must_not_contain", pattern: "forbidden", scope: "repo" },
    });

    await expect(engine.verifyOne(invariant)).resolves.toEqual([]);
    expect(client.repoCalls).toEqual([]);
  });
});

describe("truncation", () => {
  it("errors the invariant when the keyword search is truncated", async () => {
    const client = new FakeSearchClient(() => ({
      matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
      truncated: true,
    }));
    const engine = new InvariantEngine(client);

    const report = await engine.verifyAll({ invariants: [makeInvariant()] });

    expect(report.results[0].status).toBe("error");
    expect(report.results[0].error).toBe(TRUNCATION_ERROR);
    expect(report.results[0].violations).toEqual([]);
    expect(report.summary).toEqual({ total: 1, passed: 0, failed: 0, errors: 1 });
  });

  it("errors the invariant when the assertion search is truncated", async () => {
    const client = new FakeSearchClient(
      () => ({
        matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
        truncated: false,
      }),
      () => ({ matches: new Map(), truncated: true }),
    );
    const engine = new InvariantEngine(client);
    const invariant = makeInvariant({
      assertion: { type: "must_contain", pattern: "init()", scope: "repo" },
    });

    const report = await engine.verifyAll({ invariants: [invariant] });

    expect(report.results[0].status).toBe("error");
    expect(report.results[0].error).toBe(TRUNCATION_ERROR);
  });

  it("errors on a truncated assertion search for must_not_contain", async () => {
    const client = new FakeSearchClient(
      () => ({
        matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
        truncated: false,
      }),
      () => ({ matches: new Map(), truncated: true }),
    );
    const engine = new InvariantEngine(client);
    const invariant = makeInvariant({
      assertion: { type: "must_not_contain", pattern: "forbidden", scope: "repo" },
    });

    await expect(engine.verifyOne(invariant)).rejects.toThrow(TRUNCATION_ERROR);
  });
});

describe("canary invariants", () => {
  const CANARY_ERROR =
    "canary invariant found zero matches — Sourcegraph search may be broken";

  it("errors a canary that finds zero matches instead of passing", async () => {
    const client = new FakeSearchClient();
    const engine = new InvariantEngine(client);

    const report = await engine.verifyAll({
      invariants: [makeInvariant({ id: "canary-probe" })],
    });

    expect(report.results[0].status).toBe("error");
    expect(report.results[0].error).toBe(CANARY_ERROR);
    expect(report.summary).toEqual({ total: 1, passed: 0, failed: 0, errors: 1 });
  });

  it("reports a fired canary as a normal fail with its violations", async () => {
    const client = new FakeSearchClient(() => ({
      matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
      truncated: false,
    }));
    const engine = new InvariantEngine(client);

    const report = await engine.verifyAll({
      invariants: [makeInvariant({ id: "canary-probe" })],
    });

    expect(report.results[0].status).toBe("fail");
    expect(report.results[0].violations).toHaveLength(1);
  });

  it("does not error non-canary invariants with zero matches", async () => {
    const client = new FakeSearchClient();
    const engine = new InvariantEngine(client);

    const report = await engine.verifyAll({
      invariants: [makeInvariant({ id: "real-rule" })],
    });

    expect(report.results[0].status).toBe("pass");
  });
});

describe("verifyAll", () => {
  it("isolates a throwing invariant and still verifies its siblings", async () => {
    const client = new FakeSearchClient((pattern) => {
      if (pattern === "boom") throw new Error("kaboom");
      if (pattern === "bad") {
        return {
          matches: [match("acme/api", result("acme/api", "src/a.ts", 1))],
          truncated: false,
        };
      }
      return { matches: [], truncated: false };
    });
    const engine = new InvariantEngine(client);
    const config = {
      invariants: [
        makeInvariant({ id: "ok", search: { pattern: "clean", language: null } }),
        makeInvariant({ id: "broken", search: { pattern: "boom", language: null } }),
        makeInvariant({ id: "failing", search: { pattern: "bad", language: null } }),
      ],
    };

    const report = await engine.verifyAll(config);

    expect(report.results.map((r) => [r.id, r.status])).toEqual([
      ["ok", "pass"],
      ["broken", "error"],
      ["failing", "fail"],
    ]);
    expect(report.results[1].error).toBe("kaboom");
    expect(report.summary).toEqual({ total: 3, passed: 1, failed: 1, errors: 1 });
  });

  it("converts non-Error throws into 'unknown error'", async () => {
    const client = new FakeSearchClient(() => {
      throw "string failure";
    });
    const engine = new InvariantEngine(client);

    const report = await engine.verifyAll({ invariants: [makeInvariant()] });

    expect(report.results[0].status).toBe("error");
    expect(report.results[0].error).toBe("unknown error");
  });

  it("preserves config order despite concurrent completion order", async () => {
    const delays: Record<string, number> = {
      p0: 40,
      p1: 1,
      p2: 25,
      p3: 1,
      p4: 10,
      p5: 1,
    };
    const client = new FakeSearchClient(async (pattern) => {
      await new Promise((resolve) => setTimeout(resolve, delays[pattern]));
      return { matches: [], truncated: false };
    });
    const engine = new InvariantEngine(client);
    const config = {
      invariants: Object.keys(delays).map((pattern, i) =>
        makeInvariant({ id: `inv-${i}`, search: { pattern, language: null } }),
      ),
    };

    const report = await engine.verifyAll(config);

    expect(report.results.map((r) => r.id)).toEqual([
      "inv-0",
      "inv-1",
      "inv-2",
      "inv-3",
      "inv-4",
      "inv-5",
    ]);
    expect(report.summary).toEqual({ total: 6, passed: 6, failed: 0, errors: 0 });
  });

  it("returns an empty report for an empty config", async () => {
    const engine = new InvariantEngine(new FakeSearchClient());

    const report = await engine.verifyAll({ invariants: [] });

    expect(report.summary).toEqual({ total: 0, passed: 0, failed: 0, errors: 0 });
    expect(report.results).toEqual([]);
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "invariants-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(value: unknown): Promise<string> {
    const path = join(dir, "invariants.json");
    await writeFile(path, JSON.stringify(value), "utf-8");
    return path;
  }

  it("parses a valid config", async () => {
    const path = await writeConfig({ invariants: [makeInvariant()] });
    const engine = new InvariantEngine(new FakeSearchClient());

    const config = await engine.loadConfig(path);

    expect(config.invariants).toHaveLength(1);
    expect(config.invariants[0].id).toBe("inv");
  });

  it("rejects an invalid severity", async () => {
    const path = await writeConfig({
      invariants: [{ ...makeInvariant(), severity: "urgent" }],
    });
    const engine = new InvariantEngine(new FakeSearchClient());

    await expect(engine.loadConfig(path)).rejects.toThrow(/severity/);
  });

  it("rejects a missing required field", async () => {
    const { message: _omitted, ...withoutMessage } = makeInvariant();
    const path = await writeConfig({ invariants: [withoutMessage] });
    const engine = new InvariantEngine(new FakeSearchClient());

    await expect(engine.loadConfig(path)).rejects.toThrow(/message/);
  });

  it("rejects malformed JSON", async () => {
    const path = join(dir, "invariants.json");
    await writeFile(path, "{ not json", "utf-8");
    const engine = new InvariantEngine(new FakeSearchClient());

    await expect(engine.loadConfig(path)).rejects.toThrow();
  });
});
