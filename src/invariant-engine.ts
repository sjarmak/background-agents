/**
 * Core invariant verification engine.
 *
 * Parses invariant config, orchestrates verification via SourcegraphClient,
 * and produces structured results.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { SourcegraphClient, type RepoMatch } from "./sourcegraph-client.js";
import type { Violation, VerificationSummary } from "./slack-notifier.js";

// ---------------------------------------------------------------------------
// Schema (Zod for runtime validation)
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
   * Verify all invariants and return a summary.
   */
  async verifyAll(config: InvariantsConfig): Promise<VerificationSummary> {
    const start = Date.now();
    const violations: Violation[] = [];

    for (const invariant of config.invariants) {
      const result = await this.verifyOne(invariant);
      violations.push(...result);
    }

    return {
      totalInvariants: config.invariants.length,
      passed:
        config.invariants.length -
        new Set(violations.map((v) => v.invariantId)).size,
      failed: new Set(violations.map((v) => v.invariantId)).size,
      violations,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Verify a single invariant. Returns violations (empty = pass).
   */
  async verifyOne(invariant: Invariant): Promise<Violation[]> {
    console.log(`[InvariantEngine] Checking: ${invariant.id}`);

    // Step 1: Search for the pattern across all repos
    const matches = await this.sg.keywordSearch(
      invariant.search.pattern,
      invariant.search.language,
    );

    if (matches.length === 0) {
      // No matches means nothing to verify (or must_not_exist passes)
      if (invariant.assertion.type === "must_not_exist") {
        return []; // pass — pattern not found anywhere
      }
      console.log(`  No matches for search pattern, skipping assertion`);
      return [];
    }

    // Step 2: Apply assertion
    switch (invariant.assertion.type) {
      case "must_not_exist":
        return this.checkMustNotExist(invariant, matches);

      case "must_contain":
        return await this.checkMustContain(invariant, matches);

      case "must_not_contain":
        return await this.checkMustNotContain(invariant, matches);

      default:
        console.warn(`  Unknown assertion type: ${invariant.assertion.type}`);
        return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Assertion handlers
  // ---------------------------------------------------------------------------

  /**
   * must_not_exist: The search pattern itself should not appear anywhere.
   * If matches were found, every match is a violation.
   */
  private checkMustNotExist(
    invariant: Invariant,
    matches: RepoMatch[],
  ): Violation[] {
    return matches.map((m) => ({
      invariantId: invariant.id,
      description: invariant.description,
      severity: invariant.severity as Violation["severity"],
      repo: m.repo,
      message: invariant.message,
      details: `Found in ${m.files.length} file(s)`,
    }));
  }

  /**
   * must_contain: Repos/files matching the search MUST also contain the assertion pattern.
   */
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
      // Each repo that matched the search must also have the assertion pattern
      for (const repo of repos) {
        if (!assertionMatches.has(repo)) {
          violations.push({
            invariantId: invariant.id,
            description: invariant.description,
            severity: invariant.severity as Violation["severity"],
            repo,
            message: invariant.message,
          });
        }
      }
    } else {
      // File scope: each file matching the search must also contain the assertion
      for (const match of matches) {
        const repoAssertions = assertionMatches.get(match.repo) ?? [];
        const assertionFiles = new Set(repoAssertions.map((a) => a.file));

        for (const file of match.files) {
          if (!assertionFiles.has(file.file)) {
            violations.push({
              invariantId: invariant.id,
              description: invariant.description,
              severity: invariant.severity as Violation["severity"],
              repo: match.repo,
              message: invariant.message,
              details: `File ${file.file} missing required pattern`,
            });
          }
        }
      }
    }

    return violations;
  }

  /**
   * must_not_contain: Repos/files matching the search MUST NOT also contain the assertion pattern.
   */
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
      if (results.length > 0) {
        violations.push({
          invariantId: invariant.id,
          description: invariant.description,
          severity: invariant.severity as Violation["severity"],
          repo,
          message: invariant.message,
          details: `Found forbidden pattern in ${results.length} file(s)`,
        });
      }
    }

    return violations;
  }
}
