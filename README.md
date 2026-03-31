# Sherpa

Sherpa is a local-first procedural memory system for OpenClaw. It is designed to learn how workflows actually unfold from typed operational events, then provide bounded guidance about likely next steps, failure modes, and successful continuations.

At a technical level, Sherpa is a de Bruijn-style higher-order workflow memory: it treats the recent suffix of typed events as the current state, and it treats observed next events as outgoing transitions with empirical counts, probabilities, and outcome metadata.

## Status

Sherpa now has an alpha implementation:

- `@sherpa/core`: append-only ledger, batched ingest, derived SQLite graph, and retrieval primitives
- `sherpa`: CLI for ingest, rebuild, status, workflow-status, doctor, export, gc, workflow state, workflow next, workflow risks, and workflow recall
- `@sherpa/openclaw`: native OpenClaw plugin package with manifest, config schema, lifecycle event capture, explicit task-boundary case splitting, scope controls, maintenance, and native tool registration over the core engine

The product requirements document remains the product source of truth at [`prd/sherpa-prd.md`](./prd/sherpa-prd.md).

## Current Packages

- `packages/core`: core engine and types
- `packages/cli`: publishable CLI package
- `packages/openclaw`: OpenClaw plugin adapter

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

## Notes

- The current storage backend uses Node 22's built-in `node:sqlite`, which still emits an experimental warning.
- The current implementation rebuilds the derived graph from the ledger on each ingest or ingest batch. That keeps the source of truth simple now; incremental updates can come later.
- The engine now supports minimum-support variable-order backoff, richer status/freshness reporting, JSON snapshot export, and graph maintenance via `gc`.
- Risk and recall are still alpha-grade heuristics built from eventual case outcomes and suffix matching; they are useful now, but not yet the final retrieval model described in the PRD.
- The OpenClaw package now captures session lifecycle, inbound dispatch, and tool lifecycle events with redacted-by-default metadata, debounced per-store batching, periodic maintenance, conservative scope rules, ignore/stateless session patterns, explicit task-boundary case splitting from configurable markers, optional bounded advisory injection, and structured degraded responses when the backend is unavailable.
- Richer automatic case splitting beyond explicit boundaries is still to come.

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
- `docs/`: design notes, ADRs, and integration docs

## Next Steps

- Add OpenClaw richer automatic case splitting beyond explicit boundaries
- Add MCP and SDK surfaces for the standalone core
- Improve recall/risk scoring beyond the current heuristic layer
- Define a validation harness using synthetic workflow traces and real event-log datasets
- Add CI under `.github/workflows/`
- Add release/versioning automation once package boundaries settle
