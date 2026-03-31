# Sherpa

Sherpa is a local-first procedural memory system for OpenClaw. It is designed to learn how workflows actually unfold from typed operational events, then provide bounded guidance about likely next steps, failure modes, and successful continuations.

At a technical level, Sherpa is a de Bruijn-style higher-order workflow memory: it treats the recent suffix of typed events as the current state, and it treats observed next events as outgoing transitions with empirical counts, probabilities, and outcome metadata.

## Status

Sherpa now has an alpha implementation:

- `@sherpa/core`: append-only ledger, batched ingest, derived SQLite graph, and retrieval primitives
- `sherpa`: CLI for ingest, rebuild, status, workflow-status, doctor, export, gc, workflow state, workflow next, workflow risks, and workflow recall
- `@sherpa/openclaw`: native OpenClaw plugin package with manifest, config schema, embedded or subprocess transport, lifecycle event capture, explicit plus automatic task-boundary case splitting, scope controls, maintenance, and native tool registration over the core engine
- `@sherpa/sdk`: Node/Bun SDK wrapper over the same core query model
- `@sherpa/mcp`: MCP server package with stdio and stateless streamable HTTP transports over the SDK/core query model

The product requirements document remains the product source of truth at [`prd/sherpa-prd.md`](./prd/sherpa-prd.md).

## Current Packages

- `packages/core`: core engine and types
- `packages/cli`: publishable CLI package
- `packages/openclaw`: OpenClaw plugin adapter
- `packages/sdk`: publishable Node/Bun SDK package
- `packages/mcp`: publishable MCP server package

## Theory

Sherpa exists because procedural questions are different from semantic retrieval questions.

The longer research writeup is available at [`docs/research.pdf`](./docs/research.pdf).

- Semantic memory asks "what information is relevant?"
- Episodic memory asks "what happened before?"
- Procedural memory asks "given the path we are on, what usually comes next?"

The core model is a higher-order temporal graph over typed events:

- A state is the last `k` canonical events, not a chunk embedding
- An edge is an observed one-step continuation of that suffix
- Edge metadata stores support counts, transition probability, outcomes, and timing

This design is motivated by a few concrete theoretical advantages:

- Bounded candidate sets. `workflow-next` only has to inspect outgoing neighbors of the current suffix state, so candidate enumeration depends on local branching, not total memory size.
- Better next-step prediction when workflows are genuinely higher-order. If the correct next action depends on more than one prior event, collapsing history into a first-order event graph or a fuzzy semantic retrieval step introduces irreducible bias.
- Structural compression. Repeated workflow phases merge into shared suffix states instead of being re-stored as many separate text memories.
- Inspectability. The system can explain its advice using counts, support, success rates, and known failure branches rather than opaque similarity scores.

Sherpa should be thought of as a predictive temporal layer, not a causal oracle. It captures what tends to happen after a context, not what should happen in an intervention-theoretic sense.

## Quick Start

```bash
pnpm install
pnpm build
pnpm test
```

Create an event JSON file:

```json
{
  "caseId": "case-123",
  "source": "tool.docs",
  "type": "docs.requested",
  "outcome": "success",
  "labels": ["workflow:vendor-review"]
}
```

Then ingest and query it:

```bash
node packages/cli/dist/index.js --root ./.sherpa ingest event.json
node packages/cli/dist/index.js --root ./.sherpa status
node packages/cli/dist/index.js --root ./.sherpa workflow-status
node packages/cli/dist/index.js --root ./.sherpa export
node packages/cli/dist/index.js --root ./.sherpa gc
node packages/cli/dist/index.js --root ./.sherpa workflow-state --case-id case-123
node packages/cli/dist/index.js --root ./.sherpa workflow-next --case-id case-123
node packages/cli/dist/index.js --root ./.sherpa workflow-risks --case-id case-123
node packages/cli/dist/index.js --root ./.sherpa workflow-recall --case-id case-123 --mode successful
```

Or use the SDK directly:

```ts
import { SherpaClient } from "@sherpa/sdk";

const sherpa = SherpaClient.forAgent({ agentId: "main" });

await sherpa.ingest({
  caseId: "case-123",
  source: "tool.docs",
  type: "docs.requested",
  outcome: "success"
});

const next = await sherpa.workflowNext("case-123");
```

Or run the MCP stdio server:

```bash
node packages/mcp/dist/index.js --agent-id main
```

Or run the MCP HTTP server:

```bash
node packages/mcp/dist/http.js --agent-id main --host 127.0.0.1 --port 8787
```

Or run Sherpa's native JSON daemon:

```bash
node packages/cli/dist/index.js --root ./.sherpa serve --host 127.0.0.1 --port 8787
```

## Notes

- The current storage backend uses Node 22's built-in `node:sqlite`, which still emits an experimental warning.
- The current implementation rebuilds the derived graph from the ledger on each ingest or ingest batch. That keeps the source of truth simple now; incremental updates can come later.
- The engine now supports minimum-support variable-order backoff, richer status/freshness reporting, JSON snapshot export, and graph maintenance via `gc`.
- Risk and recall are still alpha-grade heuristics built from eventual case outcomes and suffix matching; they are useful now, but not yet the final retrieval model described in the PRD.
- The OpenClaw package now captures session lifecycle, inbound dispatch, and tool lifecycle events with redacted-by-default metadata, debounced per-store batching, conservative scope rules, ignore/stateless session patterns, explicit task-boundary case splitting from configurable markers, explicit task completion/failure markers, automatic task starts on the first meaningful user message, rotation after a configurable idle timeout, conservative intent-shift splitting from transition phrases plus low token overlap, terminal task events when tasks are superseded or the session ends, stale active-case expiry so old tasks do not leak into later prompts or tool calls, optional bounded advisory injection, structured degraded responses when the backend is unavailable, and a configurable backend transport that can run embedded, shell out to the Sherpa CLI, or talk to a warm local HTTP daemon.
- The MCP package now supports stdio plus a minimal stateless streamable HTTP deployment path with a `/health` endpoint for local sidecar/service use.
- The CLI now supports `ingest-batch` so subprocess transports can flush event bursts efficiently.
- The CLI now also supports `serve`, exposing a small local JSON HTTP daemon at `/health` and `/rpc`, and the OpenClaw plugin can optionally manage that daemon process itself in HTTP mode.
- `workflow_status` in the native plugin now reports plugin transport and capture/scope diagnostics in addition to core backend freshness.

## Research Direction

The current project direction is informed by higher-order Markov modeling, de Bruijn-style overlap graphs, process mining event logs, and graph-based agent memory systems.

That leads to a few practical implementation rules:

- Event typing quality is a first-class concern. Bad segmentation or noisy labels directly degrade graph quality.
- Sparse branching is an assumption worth preserving. The event alphabet should stay bounded and operational, not drift into open-ended text labels.
- Outcome annotation matters. Sherpa must not rank frequent but bad paths above less frequent successful ones.
- Hybrid memory is the right target. Sherpa complements semantic memory and conversational memory; it does not replace them.

## Goals

- Native OpenClaw plugin experience
- Local append-only event ledger
- Rebuildable derived workflow graph
- Fast deterministic procedural retrieval
- Graceful fallback when the sidecar is unavailable
- Optional SDK and MCP surfaces

## Repository Conventions

- Primary branch: `main`
- Commit identity for this repo is pinned locally to `Chris Bun <chrisbun@gmail.com>`
- Text files use LF line endings
- Build artifacts, local databases, logs, and secrets should stay out of git

## Planned Layout

- `sherpa-prd.md`: product requirements
- `packages/core`: core engine
- `packages/cli`: CLI package
- `packages/sdk`: SDK package
- `packages/mcp`: MCP package
- `docs/`: design notes, ADRs, and integration docs

## Next Steps

- Improve recall/risk scoring beyond the current heuristic layer
- Improve automatic boundary heuristics beyond phrase and token-overlap rules
- Add stronger outcome handling beyond explicit terminal markers, session-end cleanup, and stale active-case expiry
- Improve managed daemon lifecycle with restart/backoff supervision instead of simple start/wait/stop
- Define a validation harness using synthetic workflow traces and real event-log datasets
- Add CI under `.github/workflows/`
- Add release/versioning automation once package boundaries settle
