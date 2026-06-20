/**
 * Core invariant verification engine.
 *
 * Origin: Parent C (agent-sdk-service) architecture with Parent B (cli-hooks)
 * per-invariant isolation pattern grafted in. Each invariant gets its own
 * agent call with independent error handling — if one fails, others continue.
 *
 * Output uses Parent B's JSON report contract for compatibility with
 * B's post-slack.sh and post-github-comment.sh scripts.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import {
  type SourcegraphSearchClient,
  type RepoMatch,
} from "./sourcegraph-client.js";

// ---------------------------------------------------------------------------
// Schema (Zod — from Parent C)
// ---------------------------------------------------------------------------

const AssertionSchema = z.object({
  type: z.enum(["must_contain", "must_not_contain", "must_not_exist"]),
  pattern: z.string().nullable(),
  scope: z.enum(["repo", "file"]),
});

const InvariantSchema = z.object({
  id: z.string(),
  description: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  search: z.object({
    pattern: z.string(),
    language: z.string().nullable().optional(),
  }),
  assertion: AssertionSchema,
  message: z.string(),
});

const InvariantsConfigSchema = z.object({
  invariants: z.array(InvariantSchema),
});

export type Invariant = z.infer<typeof InvariantSchema>;
export type InvariantsConfig = z.infer<typeof InvariantsConfigSchema>;

// ---------------------------------------------------------------------------
// Report types (Parent B's JSON contract)
// ---------------------------------------------------------------------------

export interface Violation {
  repo: string;
  file: string;
  line: number;
  detail: string;
}

export interface InvariantResult {
  id: string;
  description: string;
  severity: string;
  status: "pass" | "fail" | "error";
  message: string;
  violations: Violation[];
  error?: string;
}

export interface VerificationReport {
  timestamp: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
  };
  results: InvariantResult[];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const CONCURRENCY_LIMIT = 4;
const TRUNCATION_ERROR =
  "search truncated at result cap; violations may be missed";
const CANARY_ERROR =
  "canary invariant found zero matches — Sourcegraph search may be broken";

export class InvariantEngine {
  constructor(private readonly sg: SourcegraphSearchClient) {}

  /**
   * Load and validate invariants from a JSON config file.
   */
  async loadConfig(configPath: string): Promise<InvariantsConfig> {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return InvariantsConfigSchema.parse(parsed);
  }

  /**
   * Verify all invariants with per-invariant isolation (from Parent B).
   * Each invariant runs independently — one failure doesn't block others.
   * Runs with bounded concurrency; results keep config-file order.
   * Returns B's JSON report contract.
   */
  async verifyAll(config: InvariantsConfig): Promise<VerificationReport> {
    const results: InvariantResult[] = new Array(config.invariants.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= config.invariants.length) return;
        results[index] = await this.verifyIsolated(config.invariants[index]);
      }
    };

    const poolSize = Math.min(CONCURRENCY_LIMIT, config.invariants.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    return {
      timestamp: new Date().toISOString(),
      summary: {
        total: config.invariants.length,
        passed: results.filter((r) => r.status === "pass").length,
        failed: results.filter((r) => r.status === "fail").length,
        errors: results.filter((r) => r.status === "error").length,
      },
      results,
    };
  }

  private async verifyIsolated(invariant: Invariant): Promise<InvariantResult> {
    console.error(`[engine] Checking: ${invariant.id} (${invariant.severity})`);

    try {
      const violations = await this.verifyOne(invariant);
      // Canary invariants are synthetic probes that MUST fire — zero matches
      // means the search path is silently broken, not a clean org (fail closed).
      if (invariant.id.startsWith("canary-") && violations.length === 0) {
        throw new Error(CANARY_ERROR);
      }
      const status = violations.length > 0 ? "fail" : "pass";
      console.error(
        `  -> ${invariant.id}: ${status} (${violations.length} violations)`,
      );

      return {
        id: invariant.id,
        description: invariant.description,
        severity: invariant.severity,
        status,
        message: invariant.message,
        violations,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "unknown error";
      console.error(`  -> ${invariant.id}: error: ${errorMsg}`);

      return {
        id: invariant.id,
        description: invariant.description,
        severity: invariant.severity,
        status: "error",
        message: invariant.message,
        violations: [],
        error: errorMsg,
      };
    }
  }

  /**
   * Verify a single invariant. Returns violations (empty array = pass).
   */
  async verifyOne(invariant: Invariant): Promise<Violation[]> {
    const { matches, truncated } = await this.sg.keywordSearch(
      invariant.search.pattern,
      invariant.search.language,
    );

    if (truncated) {
      throw new Error(TRUNCATION_ERROR);
    }

    if (matches.length === 0) {
      return []; // No matches: must_not_exist passes, others have nothing to check
    }

    switch (invariant.assertion.type) {
      case "must_not_exist":
        return this.checkMustNotExist(matches);
      case "must_contain":
        return this.checkMustContain(invariant, matches);
      case "must_not_contain":
        return this.checkMustNotContain(invariant, matches);
    }
  }

  // ---------------------------------------------------------------------------
  // Assertion handlers
  // ---------------------------------------------------------------------------

  private checkMustNotExist(matches: RepoMatch[]): Violation[] {
    const violations: Violation[] = [];
    for (const m of matches) {
      for (const f of m.files) {
        violations.push({
          repo: m.repo,
          file: f.file,
          line: f.lineNumber,
          detail: `Found deprecated pattern in ${f.file}`,
        });
      }
    }
    return violations;
  }

  private async checkMustContain(
    invariant: Invariant,
    matches: RepoMatch[],
  ): Promise<Violation[]> {
    const assertionPattern = invariant.assertion.pattern;
    if (!assertionPattern) return [];

    const repos = [...new Set(matches.map((m) => m.repo))];
    const { matches: assertionMatches, truncated } =
      await this.sg.searchInRepos(repos, assertionPattern);

    if (truncated) {
      throw new Error(TRUNCATION_ERROR);
    }

    const violations: Violation[] = [];

    if (invariant.assertion.scope === "repo") {
      for (const repo of repos) {
        if (!assertionMatches.has(repo)) {
          const firstFile = matches.find((m) => m.repo === repo)?.files[0];
          violations.push({
            repo,
            file: firstFile?.file ?? "",
            line: firstFile?.lineNumber ?? 0,
            detail: `Repo imports pattern but missing required assertion`,
          });
        }
      }
    } else {
      for (const match of matches) {
        const repoAssertions = assertionMatches.get(match.repo) ?? [];
        const assertionFiles = new Set(repoAssertions.map((a) => a.file));

        for (const file of match.files) {
          if (!assertionFiles.has(file.file)) {
            violations.push({
              repo: match.repo,
              file: file.file,
              line: file.lineNumber,
              detail: `File missing required pattern: ${assertionPattern}`,
            });
          }
        }
      }
    }

    return violations;
  }

  private async checkMustNotContain(
    invariant: Invariant,
    matches: RepoMatch[],
  ): Promise<Violation[]> {
    const assertionPattern = invariant.assertion.pattern;
    if (!assertionPattern) return [];

    const repos = [...new Set(matches.map((m) => m.repo))];
    const { matches: assertionMatches, truncated } =
      await this.sg.searchInRepos(repos, assertionPattern);

    if (truncated) {
      throw new Error(TRUNCATION_ERROR);
    }

    const violations: Violation[] = [];

    for (const [repo, results] of assertionMatches) {
      for (const r of results) {
        violations.push({
          repo,
          file: r.file,
          line: r.lineNumber,
          detail: `Found forbidden pattern in ${r.file}`,
        });
      }
    }

    return violations;
  }
}
