# Convergence Report: Background Agents with Sourcegraph MCP

## Debate Summary

Three positions debated which agents to build first from a pool of 30 brainstormed ideas:

| Position                    | Advocate   | Core Thesis                                                           |
| --------------------------- | ---------- | --------------------------------------------------------------------- |
| **Quick Wins First**        | quick-wins | Ship feasible + high-impact agents fast, extract platform organically |
| **Maximum Differentiation** | max-diff   | Build only what's impossible without Sourcegraph, novelty is the moat |
| **Platform Foundation**     | platform   | Build composable infrastructure first, every agent is a graph query   |

---

## 1. Resolved Points (Consensus)

### #25 Cross-Repo Invariant Verifier is the universal first build

**All three positions independently included #25.** It scores 14/15 (F=4, N=5, I=5) — the single highest-rated idea in the brainstorm. It satisfies every evaluation criterion simultaneously:

- **Sourcegraph showcase**: Requires `find_references` + `keyword_search` across all repos
- **Fast value**: Demoable in days, production-ready in a week
- **Composable**: Declarative rules are extensible; shared modules extracted naturally
- **Differentiated**: No IDE copilot checks invariants across repo boundaries

**Decisive argument**: quick-wins nailed it — "We're not picking easy-but-boring; we're picking easy-AND-high-impact."

### #3 Cross-Repo Semantic Merge Conflict Predictor should be in the first wave

By Round 2, all three advocates agreed #3 belongs in weeks 1-3. max-diff proposed it as the "quick win that's also maximally differentiated." quick-wins conceded it should replace #29 in their priority list. platform endorsed it as "the most visually cross-repo agent."

**Decisive argument**: max-diff's framing — "This PR in repo-A will conflict with that PR in repo-B is a sentence no other tool can say."

### Shared infrastructure should be intentional but not speculative

The debate resolved the "build platform first vs. extract later" tension with a hybrid: build real agents, but with **intentional clean boundaries** from day one (shared `SourcegraphClient`, `SlackNotifier`, CI trigger template). Not a speculative platform, but not ad-hoc spaghetti either.

**Decisive argument**: platform's "composability wall at agent #3" was acknowledged by all. quick-wins' counter — "design the schema after you know what queries agents actually make" — was equally compelling. The synthesis: extract with intention.

---

## 2. Refined Trade-offs (Not Fully Resolved)

### Dependency Impact Oracle (#1) vs. RFC Impact Simulator (#10) for week 2-3

| Factor           | #1 Dependency Impact Oracle | #10 RFC Impact Simulator     |
| ---------------- | --------------------------- | ---------------------------- |
| Feasibility      | F=4 (straightforward)       | F=3 (needs NL understanding) |
| Novelty          | N=3 (lower)                 | N=5 (higher)                 |
| Impact           | I=5 (daily value)           | I=5 (per-RFC value)          |
| Frequency of use | Every breaking change push  | Every RFC (weekly/monthly)   |
| Demo appeal      | High but familiar           | Very high ("wow" factor)     |

**What would tip the balance**: If the target audience is engineering leadership evaluating adoption, #10 wins on narrative. If the target is engineers needing daily utility, #1 wins on frequency. Build #1 if optimizing for retention; build #10 if optimizing for acquisition.

### Knowledge Graph Materializer (#30): invest in week 3-4 or defer?

All three positions agreed #30 is too speculative to build first. But platform made a strong case that by week 3, with 2-3 agents built, we'll have enough data to know if a pre-computed graph would accelerate agents #4-10. quick-wins proposed evaluating this with real data from weeks 1-2.

**What would tip the balance**: If agents #25 and #3 share >60% of their Sourcegraph query patterns, a thin caching/graph layer is worth the investment. If their patterns are highly divergent, keep agents independent.

---

## 3. Emerged Positions (New from Debate)

### "Intentional Extraction" — the synthesis approach

Neither "platform first" nor "ad-hoc extraction" won. The emerged position: **build real agents with clean module boundaries from day one, refactor into shared library at the natural extraction point (agent #3).** This was articulated most clearly by quick-wins in Round 2: "Don't just hack it together; define a clean `SourcegraphClient` interface, a `SlackNotifier`, and a `CodeOwnersResolver` as separate modules from day one."

### "Differentiation as a filter, not a priority"

max-diff's position evolved from "build the hardest differentiated thing first" to "ensure every agent we build passes the differentiation filter." The filter: "Could Copilot approximate this with single-repo access?" If yes, don't build it. If no, it's a candidate regardless of complexity. This is a selection criterion, not a sequencing strategy.

---

## 4. Strongest Arguments (Per Position)

- **quick-wins**: "Composability by extraction, not speculation. You don't know what the platform needs until you've built real agents and felt real friction." — This killed the pure platform-first approach.

- **max-diff**: "If your first agents can be approximated by Copilot Workspace on a single repo, what's the pitch? The first agents we ship define the narrative for what this platform IS." — This established the differentiation filter that all positions adopted.

- **platform**: "Single-purpose agents first will hit the composability wall by agent #3. You'll have three agents with three different Slack integration patterns, three CI trigger mechanisms. Then you refactor under production constraints." — This ensured shared infrastructure was taken seriously from day one.

---

## 5. Recommended Path

### The Converged 4-Week Plan

**Week 1: #25 Cross-Repo Invariant Verifier**

- First agent in production
- Build with intentional module boundaries: `SourcegraphClient`, `SlackNotifier`, `CITrigger`, `CodeOwnersResolver`
- Validates the full pipeline: Sourcegraph MCP → agent logic → Slack/PR output
- Runs on every CI build — immediate daily value

**Week 2: #3 Cross-Repo Semantic Merge Conflict Predictor**

- Second agent, reusing Week 1 modules
- Maximum differentiation: "this PR in repo-A conflicts with that PR in repo-B"
- Stress-tests shared modules with a different query pattern (open PRs + symbol overlap vs. invariant rules)
- Refactor shared modules based on real friction from having 2 consumers

**Week 3: #1 Dependency Impact Oracle OR #10 RFC Impact Simulator**

- Choose based on target audience (daily utility vs. demo wow-factor)
- Third consumer of shared modules — validates the platform layer
- If #1: event-driven (git push to shared library → blast radius map)
- If #10: on-demand (Slack trigger with RFC → impact simulation)

**Week 4: Evaluate and decide**

- Assess whether a Knowledge Graph (#30) would accelerate agents #4-10
- Review actual query patterns from 3 agents to inform graph schema
- Build #9 (Incident Root Cause Tracer) or begin #30 based on evidence
- Ship the week 3 agent if not yet complete

### Choices that should be revisited with more data:

- **Knowledge Graph (#30)**: Revisit after 3 agents are built and query patterns are known
- **#10 vs #1 sequencing**: Revisit based on whether adoption or retention is the bottleneck
- **#22 Code Clone Divergence Tracker**: High-value (security implications) but complex. Queue for month 2.

---

## 6. Debate Highlights (Per Advocate)

- **quick-wins**: Most decisive contribution was the "intentional extraction" synthesis — build real agents but with clean boundaries. This became the consensus approach, defeating both pure platform-first and pure ad-hoc strategies.

- **max-diff**: Most decisive contribution was the "differentiation filter" — the question "could Copilot approximate this?" became the universal selection criterion adopted by all positions. Also successfully advocated for #3 entering the first wave.

- **platform**: Most decisive contribution was the "composability wall" warning — the concrete scenario of 3 agents with 3 different integration patterns forced all positions to take shared infrastructure seriously from day one, even if built incrementally.
