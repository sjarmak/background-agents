import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectCIContext,
  exitCodeForReport,
  formatPRComment,
} from "../src/ci-trigger.js";
import type {
  InvariantResult,
  VerificationReport,
} from "../src/invariant-engine.js";

function makeResult(
  overrides: Partial<InvariantResult> & Pick<InvariantResult, "id" | "severity" | "status">,
): InvariantResult {
  return {
    description: overrides.description ?? `desc for ${overrides.id}`,
    message: overrides.message ?? `msg for ${overrides.id}`,
    violations: overrides.violations ?? [],
    ...overrides,
  };
}

function makeReport(results: InvariantResult[]): VerificationReport {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errors = results.filter((r) => r.status === "error").length;
  return {
    timestamp: "2026-04-06T00:00:00Z",
    summary: { total: results.length, passed, failed, errors },
    results,
  };
}

describe("exitCodeForReport", () => {
  it("returns 0 when all pass", () => {
    const report = makeReport([
      makeResult({ id: "a", severity: "critical", status: "pass" }),
    ]);
    expect(exitCodeForReport(report)).toBe(0);
  });

  it("returns 1 when a critical invariant fails", () => {
    const report = makeReport([
      makeResult({ id: "a", severity: "critical", status: "fail" }),
    ]);
    expect(exitCodeForReport(report)).toBe(1);
  });

  it("returns 1 when a high invariant fails", () => {
    const report = makeReport([
      makeResult({ id: "a", severity: "high", status: "fail" }),
    ]);
    expect(exitCodeForReport(report)).toBe(1);
  });

  it("returns 0 when only medium or low invariants fail", () => {
    const report = makeReport([
      makeResult({ id: "a", severity: "medium", status: "fail" }),
      makeResult({ id: "b", severity: "low", status: "fail" }),
    ]);
    expect(exitCodeForReport(report)).toBe(0);
  });

  it("excludes canary invariants from blocking exit code", () => {
    const report = makeReport([
      makeResult({ id: "canary-check", severity: "critical", status: "fail" }),
    ]);
    expect(exitCodeForReport(report)).toBe(0);
  });

  it("still blocks when canary passes but other critical fails", () => {
    const report = makeReport([
      makeResult({ id: "canary-check", severity: "critical", status: "fail" }),
      makeResult({ id: "real", severity: "high", status: "fail" }),
    ]);
    expect(exitCodeForReport(report)).toBe(1);
  });
});

describe("formatPRComment", () => {
  it("renders a passing summary with no violations section", () => {
    const report = makeReport([
      makeResult({ id: "a", severity: "critical", status: "pass" }),
    ]);
    const out = formatPRComment(report);
    expect(out).toContain("✅ Cross-Repo Invariant Check");
    expect(out).toContain("**1 passed** | **0 failed** | **0 errors**");
    expect(out).toContain("| `a` | critical | ✅ pass | 0 |");
    expect(out).not.toContain("### Violations");
  });

  it("renders failing rows and a violations section", () => {
    const report = makeReport([
      makeResult({
        id: "no-dual-db",
        severity: "high",
        status: "fail",
        violations: [
          { repo: "acme/api", file: "src/db.ts", line: 14, detail: "dual import" },
        ],
      }),
    ]);
    const out = formatPRComment(report);
    expect(out).toContain("❌ Cross-Repo Invariant Check");
    expect(out).toContain("| `no-dual-db` | high | ❌ fail | 1 |");
    expect(out).toContain("### Violations");
    expect(out).toContain("`acme/api`");
    expect(out).toContain("`src/db.ts:14`");
    expect(out).toContain("dual import");
  });

  it("truncates violation lists over 10 entries", () => {
    const violations = Array.from({ length: 12 }, (_, i) => ({
      repo: `r${i}`,
      file: "f.ts",
      line: i,
      detail: `d${i}`,
    }));
    const report = makeReport([
      makeResult({
        id: "x",
        severity: "critical",
        status: "fail",
        violations,
      }),
    ]);
    const out = formatPRComment(report);
    expect(out).toContain("_...and 2 more_");
  });

  it("includes canary invariants as rows in the table", () => {
    const report = makeReport([
      makeResult({
        id: "canary-synthetic",
        severity: "low",
        status: "fail",
        violations: [
          { repo: "test/repo", file: "f.ts", line: 1, detail: "expected" },
        ],
      }),
    ]);
    const out = formatPRComment(report);
    expect(out).toContain("`canary-synthetic`");
    expect(out).toContain("🔵 expected");
    expect(out).not.toContain("❌ fail | 1");
  });
});

describe("detectCIContext", () => {
  const envKeys = [
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_TOKEN",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to manual when no GitHub env is set", () => {
    const ctx = detectCIContext();
    expect(ctx.triggerType).toBe("manual");
    expect(ctx.repo).toBeUndefined();
    expect(ctx.prNumber).toBeUndefined();
  });

  it("detects pull_request events and parses PR number from ref", () => {
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_REPOSITORY = "acme/api";
    process.env.GITHUB_REF = "refs/pull/42/merge";
    process.env.GITHUB_TOKEN = "tkn";
    const ctx = detectCIContext();
    expect(ctx.triggerType).toBe("pr");
    expect(ctx.repo).toBe("acme/api");
    expect(ctx.prNumber).toBe(42);
    expect(ctx.githubToken).toBe("tkn");
  });

  it("treats pull_request_target like a pr event", () => {
    process.env.GITHUB_EVENT_NAME = "pull_request_target";
    process.env.GITHUB_REF = "refs/pull/7/merge";
    expect(detectCIContext().triggerType).toBe("pr");
    expect(detectCIContext().prNumber).toBe(7);
  });

  it("handles malformed PR ref by returning undefined prNumber", () => {
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_REF = "refs/heads/main";
    const ctx = detectCIContext();
    expect(ctx.triggerType).toBe("pr");
    expect(ctx.prNumber).toBeUndefined();
  });

  it("detects schedule events", () => {
    process.env.GITHUB_EVENT_NAME = "schedule";
    process.env.GITHUB_REPOSITORY = "acme/api";
    const ctx = detectCIContext();
    expect(ctx.triggerType).toBe("schedule");
    expect(ctx.repo).toBe("acme/api");
  });
});
