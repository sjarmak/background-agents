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
import { SourcegraphClient, type RepoMatch } from "./sourcegraph-client.js";

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

export class InvariantEngine {
  constructor(private readonly sg: SourcegraphClient) {}

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
   * Returns B's JSON report contract.
   */
  async verifyAll(config: InvariantsConfig): Promise<VerificationReport> {
    const results: InvariantResult[] = [];
    let passed = 0;
    let failed = 0;
    let errors = 0;

    for (const invariant of config.invariants) {
      console.error(
        `[engine] Checking: ${invariant.id} (${invariant.severity})`,
      );

      try {
        const violations = await this.verifyOne(invariant);
        const status = violations.length > 0 ? "fail" : "pass";

        if (status === "pass") passed++;
        else failed++;

        results.push({
          id: invariant.id,
          description: invariant.description,
          severity: invariant.severity,
          status,
          message: invariant.message,
          violations,
        });

        console.error(`  -> ${status} (${violations.length} violations)`);
      } catch (err) {
        errors++;
        const errorMsg = err instanceof Error ? err.message : "unknown error";
        console.error(`  -> error: ${errorMsg}`);

        results.push({
          id: invariant.id,
          description: invariant.description,
          severity: invariant.severity,
          status: "error",
          message: invariant.message,
          violations: [],
          error: errorMsg,
        });
      }
    }

    return {
      timestamp: new Date().toISOString(),
      summary: {
        total: config.invariants.length,
        passed,
        failed,
        errors,
      },
      results,
    };
  }

  /**
   * Verify a single invariant. Returns violations (empty array = pass).
   */
  async verifyOne(invariant: Invariant): Promise<Violation[]> {
    const matches = await this.sg.keywordSearch(
      invariant.search.pattern,
      invariant.search.language,
    );

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
    const assertionMatches = await this.sg.searchInRepos(
      repos,
      assertionPattern,
    );

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
    const assertionMatches = await this.sg.searchInRepos(
      repos,
      assertionPattern,
    );

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
