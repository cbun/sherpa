# Sherpa

Sherpa is a local-first procedural memory layer for [OpenClaw](https://github.com/openclaw/openclaw).

It watches the events an OpenClaw agent already produces — sessions starting, tools firing, tasks completing — and learns the *shape* of recurring work. Not facts, not conversation history: workflow structure.

After enough observations, Sherpa can tell the agent what usually comes next, which branches tend to stall or underperform, and how similar past tasks resolved. It does this without any remote service, extra LLM calls, or changes to how you use OpenClaw.

## Abstract

Contemporary LLM-based agent systems maintain two dominant forms of memory: **semantic memory** (embedding-based retrieval over stored facts and documents) and **episodic memory** (raw or summarized conversation history). Both degrade under the operational conditions that characterize long-running agentic workflows — context window saturation, lossy compaction, session discontinuity, and cross-session state leakage. Critically, neither representation captures the **procedural regularities** that emerge when an agent repeatedly executes structurally similar tasks: the typical ordering of steps, the branching points where outcomes diverge, or the temporal dynamics of successful versus unsuccessful trajectories.

Sherpa addresses this gap by introducing a **procedural memory layer** that models agent workflow structure as a **variable-order Markov chain** over typed event sequences. Events are captured from the agent's native lifecycle (session boundaries, tool invocations, task demarcations, message dispatch) and stored in an append-only local ledger. A derived **n-gram transition graph** — conceptually related to de Bruijn graphs in sequence analysis — encodes multi-order state transitions with per-edge provenance: observation support, transition-level and terminal-case outcome distributions, and temporal statistics.

The principal contributions are:

1. **A formal separation of procedural memory from semantic and episodic memory** in agent architectures, with a concrete implementation that operates over typed event traces rather than natural language embeddings or token-level attention.

2. **Variable-order suffix matching with graceful degradation.** State resolution attempts the highest-order context match first and falls back to shorter suffixes when support is insufficient, analogous to variable-order Markov models (VOMMs) and Prediction by Partial Matching (PPM) in data compression. This yields high-specificity predictions when data is abundant and bounded-quality predictions when it is not, without requiring explicit order selection.

3. **Outcome-aware transition scoring.** Branch ranking incorporates not only transition probability but also terminal case outcomes (eventual success/failure rates for cases that passed through each edge), yielding a composite score that balances frequency, quality, and confidence. Outcome analysis uses relative outcome ratios against per-state baselines to surface branches with elevated failure or stall rates.

4. **Zero-inference advisory injection.** Procedural guidance is generated deterministically from graph statistics and injected into the agent's prompt context without additional LLM calls, preserving the latency and cost profile of the underlying agent system.

5. **Local-first, ledger-grounded design.** All state is reconstructable from the append-only event ledger. The derived graph is a materialized view that can be rebuilt at any time, making the system resilient to corruption and portable across environments. No data leaves the host machine.

Sherpa draws on ideas from process mining (event logs as first-class analytical objects), higher-order Markov models (multi-step context dependence), de Bruijn graph construction (suffix-overlap structure), and sequential pattern mining (support-based transition significance). It is, to our knowledge, the first system to apply variable-order Markov modeling specifically to LLM agent tool-use and task-execution traces for the purpose of real-time procedural guidance.

## Why This Exists

Agent sessions have a specific memory problem that RAG and conversation history don't solve well.

As sessions grow, context windows fill up. Compaction kicks in. Sessions restart. Summaries drift. The agent loses its sense of *where it is in the work* — not what it knows, but what step it's on and what tends to follow.

Semantic memory answers "what do I know about X?" Sherpa answers "what usually happens next from here, and which paths tend to underperform?"

These are different questions, and they need different data structures.

## How It Works

### Event Capture

Sherpa hooks into OpenClaw's plugin lifecycle. Every session start, message, tool call, task boundary, and session end becomes a typed event:

```
session.started → message.received → tool.started → tool.succeeded → task.completed → session.ended
```

Events are normalized, redacted (raw text stripped by default), tagged with taxonomy labels, and appended to a local JSONL ledger. Each event belongs to a **case** — typically a session, but configurable via case routing rules.

The capture layer (`capture.ts`) classifies tools into families (browser, web, automation, generic tool) and applies user-defined taxonomy rules to remap types, outcomes, or labels before storage.

### The Graph: Variable-Order Markov Model

The core data structure is a **variable-order Markov model** over event type sequences, stored as n-gram state edges in SQLite.

During `rebuild()`, Sherpa reads the full event ledger and computes:

1. **State edges** — For each case's event sequence, it generates n-grams of orders 1 through `maxOrder` (default 3). Each n-gram records: the state key (event suffix), the next event type, observation count (support), success/failure counts at the transition level, terminal outcome counts (did the *case* eventually succeed/fail/stall?), and timing statistics (total/min/max duration to next event).

2. **Cases** — Per-case aggregates: event count, time span, terminal outcome inferred from the final events.

3. **Materialized tables** — Workflow aggregates, outcome metrics, success metrics, and config version history, all derived from the edges and cases.

The key insight is **de Bruijn-style suffix fallback**. When querying state, Sherpa tries the longest matching suffix first (order = `defaultOrder`). If support is below `minSupport`, it drops to shorter suffixes until it finds a match or bottoms out at `minOrder`. This gives high-context predictions when data is rich and graceful degradation when it's sparse.

```
State: [tool.started → tool.succeeded → task.completed]

Order 3 match: "tool.started → tool.succeeded → task.completed" → 12 observations
  → session.ended (8x, 67%, 90% eventual success)
  → tool.started (3x, 25%, 75% eventual success)
  → message.received (1x, 8%, eventual outcome unknown)

If order 3 has < minSupport observations, fall back to order 2:
  "tool.succeeded → task.completed" → 45 observations (broader, less specific)
```

### State Resolution (`workflowState`)

Given a case ID, Sherpa pulls the most recent events (up to `defaultOrder`), forms the state suffix, and finds the best matching edge set using the suffix fallback strategy.

Returns: current state, matched order, confidence (log-scaled from support: `0.45 + log10(support + 1) / 3`, capped at 0.99), and the matched workflow label if any event carries one.

### Next-Step Prediction (`workflowNext`)

From the matched state, Sherpa reads all outgoing edges and scores each candidate branch:

```
score = probability × qualityScore

where:
  probability = branch_support / total_support
  qualityScore = 0.55
                + 0.25 × (eventual_success_rate or 0.5)
                + 0.10 × support_confidence        # support / (support + 2)
                + 0.10 × order_confidence           # matched_order / default_order
                - 0.25 × (eventual_failure_rate or 0)
```

Candidates are sorted by score (tiebreak: probability → success rate → support) and returned with full provenance: probability, support count, success/failure rates, mean time to next event, matched order, and a human-readable reason string.

### Outcome Analysis (`workflowOutcomes`)

For each outgoing branch, Sherpa computes:

- **Failure rate** — what fraction of observations through this branch ended in a failed case
- **Stall rate** — what fraction ended in an unknown/abandoned outcome
- **Relative rate** — branch rate divided by the baseline rate across all branches from this state

Branches where failure or stall rate exceeds the baseline are flagged for attention. Each flagged branch includes a confidence score (weighted blend of support confidence and order confidence), a composite score (`probability × relativeRate × confidence`), and a suggested intervention (heuristic-based: attachment checks, approval prerequisites, or generic checkpoint advice).

### Recall (`workflowRecall`)

Finds past cases whose event sequences contain the current state suffix, using a sliding window match. For each match, it extracts the **continuation** — what happened after the matching point — and scores it:

```
score = overlap × continuationSignal × outcomeWeight

where:
  overlap = matched_order / state_length
  continuationSignal = min(1, continuation_length / 4)
  outcomeWeight = 1.0 (success) | 0.85 (failure) | 0.65 (unknown)
```

Supports filtering by outcome mode: `successful`, `failed`, or `any`. Returns the continuation sequence, distance metric, and full scoring breakdown.

### Advisory Injection

When enabled, Sherpa injects procedural guidance into the agent's context before each prompt via the `before_prompt_build` lifecycle hook:

1. Query `workflowState`, `workflowNext`, and `workflowOutcomes` for the current case
2. Pass results to `buildSherpaAdvisory()` which formats a bounded text block
3. Return as `{ prependContext: advisory }` for OpenClaw to inject

**Gating:**
- Confidence must exceed `injectThreshold` (default 0.75)
- Must have at least one candidate or flagged outcome to report
- 2-minute per-case cooldown prevents spamming every turn
- Scope rules control which chats receive advisories (direct only by default)
- Output capped at `maxChars` (default 900)

**Tracking:**
- Each injection increments an `advisoryInjections` counter in the metadata table
- No extra LLM calls — advisory text is deterministically generated from graph data

Example advisory output:

```
Sherpa advisory
Current state: tool.started → tool.succeeded → task.completed
Confidence: 0.82
Likely next:
1. session.ended (67%)
2. tool.started (25%)
Outcome note:
- message.received branch has elevated stall rate
Suggested action:
- set a checkpoint and fallback path before entering message.received
```

## Architecture

```
sherpa/
├── packages/
│   ├── core/          # Engine, graph, store, ledger, types
│   ├── cli/           # CLI interface + validation suite
│   ├── openclaw/      # OpenClaw plugin (capture, advisory, case routing, tools)
│   ├── sdk/           # Programmatic client wrapping the engine
│   └── mcp/           # MCP server (stdio + HTTP transports)
└── fixtures/          # Validation datasets
```

pnpm monorepo. Node ≥ 22 (uses `node:sqlite` natively). TypeScript throughout, built with tsup, tested with vitest.

### Core (`@sherpa/core`)

The engine (`engine.ts`) owns all stateful operations:

- **Ledger** — Append-only JSONL files in `{root}/events/`. Each event is a `SherpaEvent` validated by Zod (`SherpaEventSchema`). Events are immutable once written.

- **Graph store** — SQLite database at `{root}/graph.db` with 8 tables:
  - `events` — denormalized copy of all ledger events (rebuilt from scratch)
  - `cases` — per-case aggregates (event count, time span, terminal outcome)
  - `state_edges` — the n-gram transition model (primary key: order + state_key + next_event)
  - `metadata` — key-value store for engine state (rebuild count, config, counters)
  - `workflows` — materialized workflow-level aggregates (by label)
  - `risk_metrics` — materialized failure/stall outcome scores per state+branch
  - `success_metrics` — materialized success/failure rates per state+branch
  - `config_versions` — tracks engine configuration changes over time

- **Rebuild** — Deterministic: reads full ledger, computes all derived tables, writes atomically. The graph is always reconstructable from the ledger. WAL mode + busy timeout for concurrent access.

- **GC** — Vacuums the database, cleans temp and old export files.

- **Doctor** — Health checks: ledger readability, graph consistency, metadata integrity.

- **Export/Import** — Full snapshot export (events + graph metadata) to JSON. Import with deduplication (skips events already present by ID).

- **Metrics** — `collectMetrics()` returns adoption (event/case counts, 7-day active cases), quality (advisory injection count), efficiency (mean case duration), and reliability (rebuild count, corruption count).

### OpenClaw Plugin (`@sherpa/openclaw`)

The plugin (`plugin.ts`) integrates with OpenClaw's plugin SDK:

**Lifecycle hooks:**
- `session_started` / `session_ended` — capture session boundary events
- `before_dispatch` — capture inbound messages
- `task_started` / `task_ended` — capture task boundary events
- `tool_started` / `tool_finished` — capture tool execution events
- `before_prompt_build` — advisory injection point

**Event processing:**
- Events are batched in memory and flushed periodically (debounced) or on session end
- Scope rules (`ScopeDecision`) evaluate each event context against allow/deny rules before capture
- Case routing maps events to case IDs (default: session-based, configurable)
- Taxonomy rules can remap event types, outcomes, or add labels based on pattern matching

**Transport backends:**
- `embedded` — Engine runs in-process. Simplest setup, no IPC overhead.
- `stdio` — Shells out to the `sherpa` CLI for each operation. Useful for isolation.
- `http` — Connects to a managed HTTP daemon. Plugin auto-starts/stops the process. Best for warm-process performance with process isolation.

All three implement the same `SherpaBackend` interface.

**Tools registered (14):**

| Tool | Description |
|------|-------------|
| `workflow_status` | Health check: event/case counts, freshness, config |
| `workflow_state` | Current state for a case (suffix, confidence, matched order) |
| `workflow_next` | Ranked next-step candidates with scoring breakdown |
| `workflow_outcomes` | Failure/stall outcome analysis with interventions |
| `workflow_recall` | Similar past paths filtered by outcome |
| `workflow_taxonomy` | Event type distribution, drift detection, rare types |
| `workflow_analytics` | Hot transitions, failure branches, stall branches |
| `workflow_doctor` | Diagnostic health checks |
| `workflow_rebuild` | Force graph rebuild from ledger |
| `workflow_export` | Export full snapshot to JSON |
| `workflow_import` | Import snapshot with dedup |
| `workflow_metrics` | Adoption/quality/efficiency/reliability metrics |
| `workflow_gc` | Garbage collection |
| `workflow_ingest_event` | Manual event injection (for testing/backfill) |

### SDK (`@sherpa/sdk`)

Thin wrapper around the engine for programmatic use:

```typescript
import { SherpaClient } from "@sherpa/sdk";

const client = new SherpaClient({ rootDir: "./my-sherpa-data" });

await client.ingest({ caseId: "task-123", source: "my-app", type: "step.completed" });
await client.rebuild();

const next = await client.workflowNext("task-123");
console.log(next.candidates);
```

### MCP Server (`@sherpa/mcp`)

Exposes the engine over [Model Context Protocol](https://modelcontextprotocol.io/) via stdio or HTTP:

```bash
# stdio mode
sherpa mcp

# HTTP mode (default port 8787)
sherpa mcp --http --port 8787
```

Registers the same tool set as the OpenClaw plugin, usable from any MCP-compatible client.

### CLI (`@sherpa/cli`)

Direct command-line access to all engine operations:

```bash
sherpa --root ./.sherpa status
sherpa --root ./.sherpa workflow-next --case-id case-123
sherpa --root ./.sherpa workflow-outcomes --case-id case-123
sherpa --root ./.sherpa workflow-recall --case-id case-123 --mode successful
sherpa --root ./.sherpa taxonomy-report --recent-days 14
sherpa --root ./.sherpa analytics-report --limit 10
```

Also includes a **validation suite** for testing prediction accuracy against labeled datasets:

```bash
sherpa validate-suite --input fixtures/validation/suite.json --max-failing-datasets 10
```

## Data Model

### SherpaEvent

Every observation is a `SherpaEvent`:

```typescript
{
  eventId: string;          // UUID, auto-generated
  schemaVersion: 1;         // Always 1
  agentId: string;          // Which agent produced this
  caseId: string;           // Groups events into workflow instances
  ts: string;               // ISO-8601 timestamp
  source: string;           // Origin (e.g., "openclaw.session", "openclaw.tool")
  type: string;             // Typed event (e.g., "session.started", "tool.succeeded")
  actor: string;            // "user", "agent", or "system"
  outcome: "success" | "failure" | "unknown";
  labels: string[];         // Taxonomy labels (e.g., "tool:web_search", "workflow:meeting-prep")
  entities: string[];       // Named entities (unused currently)
  metrics: Record<string, number>;  // Numeric measurements (e.g., durationMs, contentChars)
  meta: Record<string, unknown>;    // Structured metadata (redacted by default)
}
```

Validated by Zod at ingestion. Schema is append-only — once written, events are never modified.

### State Edges

The core of the Markov model. Each row represents: "after seeing event sequence X (at order N), event Y followed Z times."

```sql
CREATE TABLE state_edges (
  order_n INTEGER NOT NULL,           -- n-gram order (1 to maxOrder)
  state_key TEXT NOT NULL,            -- "event_a → event_b → event_c"
  next_event TEXT NOT NULL,           -- what followed
  support INTEGER NOT NULL,           -- observation count
  success_count INTEGER NOT NULL,     -- transitions where next_event had outcome=success
  failure_count INTEGER NOT NULL,     -- transitions where next_event had outcome=failure
  terminal_success_count INTEGER,     -- cases through this edge that eventually succeeded
  terminal_failure_count INTEGER,     -- cases through this edge that eventually failed
  terminal_unknown_count INTEGER,     -- cases through this edge that stalled/abandoned
  total_duration_ms INTEGER,          -- cumulative time between current and next event
  min_duration_ms INTEGER,
  max_duration_ms INTEGER,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (order_n, state_key, next_event)
);
```

## Configuration

Full config with defaults:

```json
{
  "transport": {
    "mode": "embedded"
  },
  "engine": {
    "defaultOrder": 3,
    "minOrder": 1,
    "maxOrder": 5,
    "minSupport": 2
  },
  "advisory": {
    "enabled": true,
    "injectThreshold": 0.75,
    "maxCandidates": 3,
    "maxRisks": 2,
    "maxChars": 900,
    "scope": "direct"
  },
  "scope": {
    "default": "deny",
    "rules": [
      { "action": "allow", "match": { "chatType": "direct" } }
    ]
  },
  "capture": {
    "messages": true,
    "tools": true,
    "browser": true,
    "web": true,
    "automation": true
  },
  "ledger": {
    "redactRawText": true,
    "maxMetaBytes": 2048
  },
  "taxonomy": {
    "rules": []
  }
}
```

**Engine tuning:**
- `defaultOrder` — Primary n-gram order for predictions. Higher = more specific but needs more data. Default 3.
- `minOrder` — Lowest order for suffix fallback. Default 1.
- `maxOrder` — Highest order computed during rebuild. Default 5.
- `minSupport` — Minimum total support to consider an edge set valid. Default 2.

**Taxonomy rules** let you remap events before storage:

```json
{
  "taxonomy": {
    "rules": [
      {
        "match": { "kind": "tool", "toolName": "web_search" },
        "set": { "type": "research.web_search", "labels": ["phase:research"] }
      }
    ]
  }
}
```

## Installation

Sherpa is not yet published to the plugin registry. Install from a local build:

```bash
git clone https://github.com/cbun/sherpa.git
cd sherpa
pnpm install
pnpm build

# Link or point OpenClaw at the local package
openclaw plugins install --local ./packages/openclaw
```

### Quick Start Config

```json
{
  "plugins": {
    "entries": {
      "sherpa": {
        "enabled": true,
        "config": {
          "transport": { "mode": "embedded" },
          "advisory": { "enabled": true, "injectThreshold": 0.75 },
          "scope": {
            "default": "deny",
            "rules": [
              { "action": "allow", "match": { "chatType": "direct" } }
            ]
          }
        }
      }
    }
  }
}
```

Restart OpenClaw. Data stores under `~/.openclaw/agents/{agentId}/sherpa/` by default.

## Local Development

```bash
pnpm install
pnpm build
pnpm test           # 71 tests across all packages
pnpm typecheck      # All 5 packages

# Validation suite
pnpm validate-suite --input fixtures/validation/suite.json

# Direct CLI usage
node packages/cli/dist/index.js --root ./.sherpa status
node packages/cli/dist/index.js --root ./.sherpa workflow-next --case-id case-123
```

## Current State

Sherpa is usable and production-oriented. The capture pipeline, graph engine, advisory injection, all tools, SDK, MCP server, and CLI are complete and tested.

The main area for future improvement is ranking quality — making predictions smarter as validation corpora grow and real-world usage patterns emerge.
