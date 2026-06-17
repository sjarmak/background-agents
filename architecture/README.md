# Architecture diagram (LikeC4)

Architecture-as-code model of the **Cross-Repo Invariant Verifier**, rendered
with [LikeC4](https://likec4.dev). The model is the source of truth across
[`spec.c4`](spec.c4) (element kinds, tags, deployment node kinds),
[`model.c4`](model.c4) (the system), and [`views.c4`](views.c4) (structure,
walkthrough, and risk views), with the deployment model in
[`deployment.c4`](deployment.c4). The narrative companion is the repo-root
[`README.md`](../README.md) and [`CLAUDE.md`](../CLAUDE.md).

Every element `link`s to its source (`src/…`, `config/…`, `.github/…`,
`scripts/…`) — so any box in the explorer is one click from the code.

## Delivery state is tagged, not guessed

Every element carries a tag so opt-in / superseded paths render distinctly from
what is already built and exercised by CI (legend in `spec.c4`):

| Tag | Meaning | Render |
|---|---|---|
| `#built` | code path exists and is exercised (workflows / tests run it) | solid |
| `#evolving` | built, but the contract/coverage is still moving (opt-in MCP, legacy runner) | solid, amber |
| `#planned` | designed; not yet implemented | **dashed, dimmed** |
| `#research` | speculative track | **dashed, indigo** |

This repo is overwhelmingly `#built`: the default GraphQL path, the engine, the
two workflows, the trust boundary, and the notification scripts are all real and
unit-tested. The `#evolving` items are the **opt-in `--mcp` agent backend**
(`SourcegraphMCPClient`, exercised by no workflow) and the **legacy Claude-CLI
runner** (`scripts/verify-invariants.sh`, superseded by the Node CLI). There are
no `#planned` or `#research` elements — the model reflects shipped reality.

## Views

**Structure** — the static map:

| View | Scope |
|---|---|
| `index` | system landscape — the verifier in context of GitHub, Sourcegraph, Slack, Anthropic models |
| `verifierSystem` | the system decomposed into containers (Node CLI, invariant config, CI harness) |
| `appContainer` | the Node verifier (`src/`) — entrypoint, engine, GraphQL + MCP clients, verdict policy |
| `engineView` | `InvariantEngine` internals — per-invariant isolation, assertion handlers, canary guard |
| `ciContainer` | the CI harness (`.github/` + `scripts/`) — workflows, trust boundary, comment upsert, Slack post |
| `planned` | opt-in & superseded paths (MCP backend + legacy runner) with the built core dimmed |
| `deployment` | where each piece runs — ephemeral Node process on an Actions runner, no server/DB |

**Walkthrough flows** (dynamic / numbered-step views) — the narrative spine for
a design-review walkthrough:

| View | Flow |
|---|---|
| `prCheckFlow` | a PR check end-to-end (trust-boundary pin → run → gate on exit code → upsert comment) |
| `verifyOneFlow` | verifying one invariant (search → assertion → canary/truncation fail-closed) |
| `mcpFlow` | the opt-in MCP / agent backend (manual runs only) |

**Risk lens:**

| View | Scope |
|---|---|
| `risks` | the `#risk`-flagged elements with each open question stated in-box (MCP truncation blind spot, partial trust-boundary coverage) |

### Running the walkthrough

For a design review, present in this order: `index` → `verifierSystem` (orient
on structure) → `prCheckFlow` and `verifyOneFlow` (what actually happens on the
default path) → `mcpFlow` (the opt-in path) → `deployment` (where it runs) →
`risks` (what to probe). In `npx likec4 start`, the dynamic views animate
step-by-step.

## Viewing & regenerating

```bash
# Interactive, hot-reloading explorer (recommended)
npx likec4 start architecture

# Re-export static PNGs (needs a one-time browser download:
#   npx playwright install chromium-headless-shell)
npx likec4 export png architecture -o architecture/exports

# Validate the model (strict — the source of truth for correctness)
npx likec4 validate architecture
```

### Viewing the interactive explorer over SSH (headless remote)

`likec4 start` serves a Vite dev server on `localhost:5173`. From a headless
remote, forward that port to your laptop and open it locally — three options,
easiest first:

1. **VS Code / Cursor Remote-SSH** — run `npx likec4 start architecture` in the
   integrated terminal; the editor auto-forwards 5173 and offers "Open in
   Browser". Nothing else to configure.
2. **SSH local port-forward** — on your laptop:
   ```bash
   ssh -N -L 5173:localhost:5173 user@remote   # leave running
   ```
   then on the remote `npx likec4 start architecture` and open
   <http://localhost:5173> locally. (Already in an SSH session? Add the tunnel
   without reconnecting: press `~C` then type `-L 5173:localhost:5173`.)
3. **Bind + reach directly** — `npx likec4 start architecture --listen 0.0.0.0`
   and browse to `http://<remote-ip>:5173` (only if that port is reachable /
   firewall-open; the tunnel in option 2 is safer).
