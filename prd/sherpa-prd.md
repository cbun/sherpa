# PRD: Sherpa

**Working name:** Sherpa
**Category:** Procedural memory for OpenClaw
**Status:** Draft v0.1
**Primary target:** OpenClaw local-first users running repeated workflows, long-lived agent sessions, and automations

## 1. Executive summary

Sherpa is a local-first procedural memory system for OpenClaw. It learns how work actually unfolds by watching typed events from sessions, tool calls, browser runs, and automations, then building a higher-order workflow graph over those events.

Sherpa is not semantic search and not context compaction.

* QMD answers: “What document or note is relevant?”
* Lossless Claw answers: “What happened earlier in this conversation?”
* Sherpa answers: “Given the path we are on, what usually comes next, what tends to fail, and what successful branch should we follow?”

The product goal is to make Sherpa feel as native inside OpenClaw as Lossless Claw and QMD do:

* one-step installation
* local storage
* rebuildable derived indexes
* bounded native tools
* background sync
* graceful fallback
* optional MCP and SDK surfaces

## 2. Problem

OpenClaw already has two strong memory patterns:

1. **Conversation/context memory**
   Lossless Claw preserves full conversation history and compacts it into a searchable DAG while keeping raw messages recoverable. ([GitHub][1])

2. **Semantic document memory**
   OpenClaw’s memory system is Markdown-first, and QMD can replace the built-in search backend while still treating Markdown as the source of truth. ([openclawlab.com][2])

What is still missing is **procedural memory**:

* Which branch of a workflow are we in?
* What next action is most likely to succeed from here?
* Which paths commonly stall or fail?
* What sequence patterns correlate with successful completion?

Today, agents mostly recover this by re-reading text, doing semantic search, or inferring from the current prompt. That is expensive, fuzzy, and often wrong for repeated operational flows.

## 3. Product thesis

Agents need a third memory layer:

* **episodic**: what happened
* **semantic**: what is true
* **procedural**: how things tend to unfold

Sherpa is the procedural layer.

It should:

* observe meaningful agent and workflow events
* normalize them into a compact event alphabet
* build variable-order path memory over recent event windows
* return likely next actions, risks, and similar successful branches
* do all of this locally and fast, without requiring another LLM call for the core path logic

### 3.1 Theoretical basis

Sherpa is based on a **de Bruijn-style higher-order workflow memory**.

Core idea:

* define state as the recent suffix of typed workflow events
* define edges as observed next-step continuations of that suffix
* attach empirical statistics to edges rather than relying on semantic similarity over raw text

This matters because procedural memory has a different retrieval problem than semantic memory:

* semantic retrieval tries to find relevant facts or documents
* procedural retrieval tries to enumerate plausible next branches from the current path

Under sparse workflow dynamics, this gives Sherpa three important advantages:

* **bounded candidate enumeration**: next-step candidates are the out-neighbors of the current state, so retrieval cost depends on local branching factor rather than total memory size
* **higher-order fidelity**: when the correct next action depends on more than one previous event, first-order event graphs or fuzzy semantic retrieval incur irreducible bias
* **structural compression and inspectability**: repeated suffixes collapse into shared states with explicit counts, success rates, and timing statistics

The closest formal lens is a variable-order Markov model over typed event suffixes, implemented as a local derived workflow graph.

### 3.2 Theoretical limits and design implications

The same theory also makes the risks explicit:

* **state explosion**: worst-case state count grows exponentially with order `k`
* **typing noise**: poor event segmentation or unstable type labels create spurious states and transitions
* **predictive not causal**: observed adjacency means “what tends to follow,” not “what would happen under intervention”
* **frequency traps**: common paths are not always good paths

These limits directly justify several design choices in Sherpa:

* bounded event alphabets
* variable-order backoff instead of a single fixed order everywhere
* success/failure annotation on edges
* small bounded advisory outputs
* explicit coexistence with semantic and conversational memory

## 4. Product principles

### 4.1 Native OpenClaw experience

Installation and configuration should feel like first-class OpenClaw functionality, not a bolted-on script.

### 4.2 Local-first by default

All data stays local unless the user explicitly enables external transport.

### 4.3 Canonical ledger, derived graph

The source of truth is an append-only event ledger. The workflow graph is derived and fully rebuildable.

### 4.4 Bounded advice

Sherpa should not dump giant histories into context. It should return small, high-confidence procedural hints.

### 4.5 Non-blocking

If Sherpa is unavailable, OpenClaw must continue operating normally.

### 4.6 One engine, many adapters

Like QMD, the core should be reusable via native integration, CLI, MCP, and SDK. ([GitHub][3])

### 4.7 No OpenClaw fork

v1 should require no OpenClaw fork. The only acceptable core changes would be tiny upstreamable hooks if the plugin API cannot expose enough lifecycle events.

### 4.8 Predictive, inspectable retrieval

Sherpa should prefer retrieval that is inspectable from graph structure and empirical counts.

Advice should be explainable in terms of:

* matched suffix state
* support count
* candidate branch probabilities
* observed success/failure rates
* known timing or stall characteristics

### 4.9 Variable-order pragmatism

The product should behave like a variable-order workflow memory, even if implementation rolls out in stages.

Implications:

* exact longer suffix matches are preferred when support is adequate
* retrieval should back off to shorter suffixes when the graph is sparse
* alpha can ship with fixed-order defaults, but the architecture should not block suffix backoff or mixture-based retrieval later

## 5. Users

### Primary user

A self-hosting OpenClaw user who runs repeated workflows such as:

* research requests
* coding tasks
* browser automation
* support and ops flows
* recurring personal workflows

### Secondary user

A developer building custom OpenClaw agents who wants:

* procedural hints for next actions
* stable local APIs
* optional reuse from other agent stacks

### Tertiary user

An operator who wants:

* fast install
* low-maintenance background updates
* easy rebuild, status, and debugging

## 6. Scope

### In scope for v1

* Local OpenClaw integration
* Per-agent event ledger
* Derived workflow graph
* Native OpenClaw tools for procedural retrieval
* Optional auto advisory injection
* Local CLI
* Health, rebuild, and debug commands
* Graceful fallback
* Optional MCP and SDK surfaces

### Out of scope for v1

* Replacing OpenClaw’s Markdown memory
* Replacing QMD
* Replacing Lossless Claw
* Global team-shared graphs across multiple machines
* Heavy visual dashboard
* Full causal inference
* End-to-end autonomous policy control

## 7. Product shape

## 7.1 Packaging

Sherpa ships as three deliverables:

### A. `@sherpa/openclaw`

Thin OpenClaw plugin. This is the primary user install target.

Responsibilities:

* register Sherpa tools inside OpenClaw
* capture lifecycle events from sessions/tools/automation
* write canonical event ledger entries
* query the local Sherpa engine
* inject bounded procedural advisories when enabled
* expose status to OpenClaw diagnostics

### B. `sherpa`

Local core engine and CLI.

Responsibilities:

* ingest normalized events
* maintain per-agent graph store
* answer procedural queries
* rebuild graph from ledger
* provide health/status/doctor commands
* optionally expose MCP over stdio or HTTP

### C. `@sherpa/sdk`

Optional Node/Bun SDK over the same core query model.

This directly copies the best part of QMD’s packaging model: one core, multiple entry points. ([GitHub][3])

## 7.2 Installation model

### OpenClaw install target

Default install should be:

```bash
openclaw plugins install @sherpa/openclaw
```

Expected behavior:

* plugin is recorded and enabled
* default plugin config is written if absent
* required compatible settings are applied automatically where possible
* no manual JSON editing needed for the default path
* `openclaw health` should surface Sherpa status

This mirrors the smooth plugin behavior Lossless Claw already aims for. ([GitHub][1])

## 7.3 Runtime model

Sherpa should run as a local sidecar process managed by the plugin.

Default transport:

* local subprocess
* JSON over stdio

Optional transport:

* local HTTP daemon for warm, long-lived service
* MCP stdio
* MCP HTTP

The HTTP daemon mode is intentionally copied from the QMD pattern because it avoids repeated startup cost and makes multi-client use cleaner. ([GitHub][3])

## 8. User experience

## 8.1 What the user sees

After install, OpenClaw keeps working normally. The user gets new capabilities:

### Native tools

* `workflow_state`
* `workflow_next`
* `workflow_risks`
* `workflow_recall`
* `workflow_status`

### Optional silent advisory

Before a major decision turn, Sherpa may inject a small internal advisory like:

```text
Sherpa advisory
Current state: docs_requested -> docs_received -> review_started
Confidence: 0.82
Likely next:
1. approval_needed (58%)
2. issue_found (23%)
Top risk:
- missing_attachment branch has high stall rate
Suggested action:
- verify attachment completeness before drafting final output
```

### Status and maintenance

* `sherpa status`
* `sherpa rebuild`
* `sherpa doctor`
* `sherpa export`

## 8.2 What the user should not have to do

* hand-run indexing jobs in normal operation
* manually copy logs into the system
* choose between Sherpa and QMD
* learn a separate UI for the core path-retrieval experience

## 9. Detailed functional requirements

## TM-01: Native install and enablement

Sherpa must install as a normal OpenClaw plugin.

Acceptance criteria:

* one command install
* plugin appears in OpenClaw plugin inventory
* plugin enabled by default after install
* clear health output if dependencies are missing
* uninstall removes plugin cleanly without touching canonical ledgers unless user requests deletion

## TM-02: Canonical event ledger

Sherpa must store an append-only canonical event ledger as the source of truth.

Default path:

```text
~/.openclaw/agents/<agentId>/sherpa/events/
```

Format:

* JSONL shards by date or case
* append-only
* versioned schema
* rebuildable into graph store

Design rule:

* the ledger is canonical
* graph DB is derived
* corruption of graph DB must never destroy history

## TM-03: Derived graph store

Sherpa must maintain a local derived workflow graph store.

Default path:

```text
~/.openclaw/agents/<agentId>/sherpa/graph.sqlite
```

It must store:

* typed events
* case windows
* variable-order states
* transition counts
* success and failure stats
* time-to-next distributions
* basic retrieval indices

## TM-04: Event capture

Sherpa plugin must capture meaningful events from OpenClaw.

Initial capture sources:

* session turn boundaries
* tool invocation start/success/failure
* browser actions
* web actions
* automation and cron jobs
* webhook-triggered jobs
* file request/receive events when inferable
* explicit task boundary markers
* optional memory-write events

Not every raw token is an event. Capture should happen at meaningful operational boundaries.

## TM-05: Event normalization

Sherpa must map raw activity into a finite typed event alphabet.

Canonical event form:

```json
{
  "eventId": "evt_01...",
  "schemaVersion": 1,
  "agentId": "main",
  "caseId": "session:discord:dm:123",
  "ts": "2026-03-30T12:34:56Z",
  "source": "tool.browser",
  "type": "browser.navigate.success",
  "actor": "agent",
  "outcome": "success",
  "labels": ["workflow:research"],
  "entities": ["url:example.com"],
  "metrics": { "durationMs": 812 },
  "meta": {}
}
```

Requirements:

* stable canonical type strings
* bounded cardinality
* custom normalization rules supported
* raw sensitive text redacted by default
* opaque IDs allowed where needed

## TM-06: Case identity

Sherpa must group events into cases.

Default case key sources:

* normalized session key
* automation run ID
* explicit task/correlation ID if present

Requirements:

* one session may contain multiple cases over time
* plugin may open a new case when user or automation explicitly starts a new task
* case splitting must be configurable

## TM-07: Workflow graph model

Sherpa must represent recent history as higher-order path state.

Requirements:

* default order `k = 3`
* configurable min/max order
* variable-order backoff supported
* state = recent event suffix
* edge = observed next event
* edge stats include support, transition probability, success rate, fail rate, mean and quantile time-to-next

The model should be deterministic and queryable without another LLM call.

## TM-08: Retrieval primitives

Sherpa must support five retrieval primitives.

### `workflow_state`

Returns:

* inferred current state
* support/confidence
* recent canonical events
* matched workflow label if any

### `workflow_next`

Returns:

* top candidate next events or action classes
* support
* estimated probability
* short reason fields

### `workflow_risks`

Returns:

* likely stall branches
* likely fail branches
* risk uplift vs baseline
* suggested intervention if known

### `workflow_recall`

Returns:

* similar successful paths
* similar failed paths
* shortest successful continuation from current state when available

### `workflow_status`

Returns:

* backend health
* ledger freshness
* graph freshness
* counts of cases/events/states
* active config summary

## TM-09: Native tool registration

The OpenClaw plugin must expose Sherpa retrieval as native OpenClaw tools, not only as an external MCP server.

Reason:
QMD succeeds in OpenClaw because OpenClaw shells out locally and preserves native memory tool behavior. Sherpa should feel equally native. ([openclawlab.com][2])

## TM-10: Optional automatic advisory injection

Sherpa should support an optional pre-turn advisory mode.

Rules:

* disabled by default in alpha, enabled by default in beta after validation
* only inject when confidence/support threshold is met
* max advisory size capped
* never inject if result is weak or noisy
* default scope is direct/private chats only
* group/channel usage must be opt-in

## TM-11: Background maintenance

Sherpa must update in the background.

Default behaviors:

* initialize on gateway/plugin startup
* debounce write bursts
* periodic graph maintenance
* periodic stale-case cleanup
* periodic risk metric recomputation

Config:

* `onBoot`
* `interval`
* `debounceMs`
* `commandTimeoutMs`
* `rebuildOnVersionChange`

This is deliberately similar to how OpenClaw manages the QMD sidecar lifecycle. ([openclawlab.com][2])

## TM-12: Graceful fallback

If Sherpa is unavailable:

* OpenClaw continues normally
* no turn should hard-fail because Sherpa is down
* status surfaces the degraded mode
* plugin logs a warning
* tools return structured “backend unavailable” errors
* auto advisory injection silently skips

This should mirror the operational philosophy of the QMD fallback path in OpenClaw. ([openclawlab.com][2])

## TM-13: Scope and privacy rules

Sherpa must support scope rules similar to OpenClaw’s QMD scoping model.

Requirements:

* default deny in non-direct contexts
* allow direct/private by default
* rules by normalized session key prefix
* rules by raw session key prefix
* optional stateless sessions
* optional ignore patterns

This also aligns with the Lossless Claw idea of ignored or stateless session patterns. ([GitHub][1])

## TM-14: Health and repair

Sherpa must provide:

* `sherpa status`
* `sherpa doctor`
* `sherpa rebuild`
* `sherpa gc`
* `sherpa export`

Requirements:

* rebuild from ledger only
* corruption in graph store recoverable without manual DB surgery
* clear exit codes for automation

## TM-15: SDK and MCP surfaces

Sherpa core must expose:

* CLI
* Node/Bun SDK
* MCP stdio
* MCP HTTP daemon

The OpenClaw plugin is primary, but the core must remain reusable.

## 10. OpenClaw integration spec

## 10.1 Integration strategy

We will copy the best parts of both reference integrations:

### From Lossless Claw

* install as a native OpenClaw plugin
* plugin-owned config under `plugins.entries`
* manifest-driven `configSchema` and `uiHints`
* native tools registered inside OpenClaw
* no manual post-install slot wiring in the default path ([GitHub][1])

### From QMD

* local sidecar core
* OpenClaw plugin shells out to local process
* per-agent isolated home directory
* background update model
* graceful fallback
* optional MCP and SDK surfaces ([openclawlab.com][2])

## 10.2 v1 core decision

**No new OpenClaw core slot in v1.**

Sherpa will not require a new `proceduralMemory` slot in core to ship alpha. It will live as a standard plugin entry that:

* captures events
* manages the local sidecar
* exposes tools
* optionally injects advisories

If Sherpa proves durable and broadly useful, we can later propose a dedicated core slot upstream.

## 10.3 OpenClaw config

### Default plugin config

```json
{
  "plugins": {
    "entries": {
      "sherpa": {
        "enabled": true,
        "config": {
          "transport": {
            "mode": "stdio",
            "command": "sherpa"
          },
          "store": {
            "root": "~/.openclaw/agents/{agentId}/sherpa"
          },
          "ledger": {
            "redactRawText": true,
            "maxMetaBytes": 2048
          },
          "capture": {
            "messages": true,
            "tools": true,
            "browser": true,
            "web": true,
            "automation": true,
            "memoryWrites": false
          },
          "order": {
            "default": 3,
            "min": 1,
            "max": 5,
            "backoff": true
          },
          "advisory": {
            "enabled": false,
            "injectThreshold": 0.75,
            "maxCandidates": 3,
            "maxRisks": 2,
            "maxChars": 900
          },
          "update": {
            "onBoot": true,
            "interval": "5m",
            "debounceMs": 10000,
            "commandTimeoutMs": 3000
          },
          "scope": {
            "default": "deny",
            "rules": [
              { "action": "allow", "match": { "chatType": "direct" } }
            ]
          },
          "ignoreSessionPatterns": [
            "agent:*:cron:**"
          ],
          "statelessSessionPatterns": []
        }
      }
    }
  }
}
```

## 10.4 Plugin manifest requirements

Like Lossless Claw, Sherpa plugin must ship a manifest containing:

* `id`
* `configSchema`
* `uiHints`

At minimum, UI hints should exist for:

* advisory enabled
* order settings
* update cadence
* scope rules
* redact raw text
* ignore/stateless session patterns
* transport mode
* store root

## 10.5 Storage layout

```text
~/.openclaw/
  agents/
    <agentId>/
      sherpa/
        events/
          2026-03-30.jsonl
          2026-03-31.jsonl
        graph.sqlite
        cache/
        tmp/
        export/
```

## 10.6 Compatibility with existing memory

Sherpa must coexist with:

* built-in Markdown memory
* QMD backend
* Lossless Claw context engine

No existing memory or context engine should need to be disabled.

Recommended mental model:

* `memory_search` / `memory_get`: semantic recall
* Lossless Claw tools: episodic conversational recall
* Sherpa tools: procedural path recall

## 11. Query and tool behavior

## 11.1 `workflow_state`

**Input**

```json
{
  "caseId": "optional",
  "maxOrder": 3
}
```

**Output**

```json
{
  "caseId": "session:discord:dm:123",
  "state": [
    "docs.requested",
    "docs.received",
    "review.started"
  ],
  "matchedWorkflow": "vendor-review",
  "confidence": 0.82,
  "support": 143
}
```

## 11.2 `workflow_next`

**Input**

```json
{
  "caseId": "optional",
  "limit": 5
}
```

**Output**

```json
{
  "candidates": [
    {
      "event": "approval.needed",
      "probability": 0.58,
      "support": 91,
      "successRate": 0.77
    },
    {
      "event": "issue.found",
      "probability": 0.23,
      "support": 37,
      "successRate": 0.41
    }
  ]
}
```

## 11.3 `workflow_signals` (replaces `workflow_risks` in Phase 5)

**Input**

```json
{
  "caseId": "optional",
  "limit": 5
}
```

**Output**

```json
{
  "signals": [
    {
      "state": ["user.command.config", "agent.edit", "user.correction"],
      "prediction": "user.correction",
      "probability": 0.42,
      "support": 23,
      "userResponseDist": {
        "correction": 0.42,
        "approval": 0.25,
        "pivot": 0.18,
        "escalation": 0.15
      },
      "basis": [
        {
          "caseId": "case_9f...",
          "context": "the port should be 8080 not 3000"
        },
        {
          "caseId": "case_a2...",
          "context": "no, revert that, the env var takes precedence"
        }
      ]
    }
  ]
}
```

> **Backward compatibility:** `workflow_risks` remains available as a convenience wrapper that filters `workflow_signals` for high-correction/escalation distributions. Deprecated — callers should migrate to `workflow_signals`.

## 11.3.1 `workflow_risks` (deprecated, Phase 5)

**Input/Output**: Same as previous spec. Internally delegates to `workflow_signals` and filters for states where correction + escalation + abandonment probability > threshold.

## 11.4 `workflow_recall`

**Input**

```json
{
  "caseId": "optional",
  "mode": "successful",
  "limit": 3
}
```

**Output**

```json
{
  "paths": [
    {
      "caseId": "case_9f...",
      "distance": 0.12,
      "outcome": "success",
      "continuation": [
        "approval.needed",
        "approval.granted",
        "report.sent"
      ]
    }
  ]
}
```

## 11.5 `workflow_status`

**Output**

```json
{
  "backend": "sherpa",
  "healthy": true,
  "events": 18423,
  "cases": 912,
  "states": 3371,
  "lastUpdateAt": "2026-03-30T12:40:00Z",
  "advisoryEnabled": false
}
```

## 12. Data model

## 12.1 Canonical data

Append-only JSONL event ledger.

## 12.2 Derived data

SQLite graph store with at least these logical tables:

* `events`
* `cases`
* `states`
* `state_edges` (includes `response_dist` JSON column for user response distributions)
* `workflows`
* `config_versions`

> **Note (Phase 5):** `risk_metrics` and `success_metrics` tables from Phase 3 are deprecated. User behavioral patterns are now captured as response distributions on `state_edges`, computed during `rebuild()` from enriched event types.

## 12.3 Graph semantics

* node = suffix of recent typed events
* edge = observed next typed event
* variable-order queries back off from `k=max` to shorter suffixes when sparse
* statistics are empirical, not causal

## 12.4 Retention

Default retention:

* keep ledger forever unless user config says otherwise
* derived caches may be compacted
* graph may age stale stats but never mutate ledger history

## 12.5 Research-informed graph semantics

To preserve usefulness and avoid state explosion, the graph model should follow these additional rules:

* event types should be discrete, operational, and bounded in cardinality
* state IDs should be derived from canonical suffixes, not free-form text
* edge metadata should prioritize support, outcome, and timing before richer derived signals
* richer labels such as anomaly scores or risk tags should be additive, not part of the canonical state identity

## 13. Security, privacy, and governance

## 13.1 Local-first default

Sherpa stores everything locally by default.

## 13.2 Redaction default

Raw user text should not be stored in ledger by default unless explicitly enabled.

Default approach:

* typed event only
* short bounded metadata
* hashed or opaque entity IDs where possible

## 13.3 Scope default

Default scope should mirror the conservative posture OpenClaw already uses for sensitive memory surfacing:

* allow in direct chats
* deny in channels/groups unless explicitly allowed ([openclawlab.com][2])

## 13.4 No hidden outbound network dependency

Core Sherpa graph logic must not require external API calls.

Optional MCP HTTP is local-only unless user explicitly rebinds it.

## 13.5 Auditability

Every advisory must be explainable from:

* current inferred state
* underlying support counts
* matched prior paths

## 14. Non-functional requirements

### Performance

Targets for warm local process:

* event ingest p50 < 10 ms
* query p50 < 80 ms
* query p95 < 250 ms
* auto advisory generation without extra LLM call

### Reliability

* no hard dependency on Sherpa for core OpenClaw turns
* rebuild from ledger must succeed after graph corruption
* upgrade path must preserve old ledgers

### Modeling quality

* event normalization must preserve bounded cardinality
* retrieval should degrade gracefully under sparse support by backing off to shorter suffixes
* recommendations should prefer expected utility over raw transition frequency when outcome labels exist

### Portability

* macOS and Linux first
* Windows via WSL acceptable in v1
* same practical support posture as QMD inside OpenClaw is acceptable for first release ([openclawlab.com][2])

## 15. Success metrics

## 15.1 Adoption metrics

* % of installs that complete successfully
* % of active OpenClaw agents with Sherpa enabled after 7 days
* % using at least one Sherpa tool per week

## 15.2 Quality metrics

* precision@3 for `workflow_next`
* risk alert precision before actual stall/failure
* operator rating for usefulness of advice
* manual disable rate of advisory mode

## 15.3 Efficiency metrics

* reduction in repeated failed tool loops
* reduction in time-to-completion for repeated workflows
* reduction in unnecessary semantic memory lookups for procedural questions
* no meaningful increase in turn latency

## 15.4 Reliability metrics

* fallback invocation rate
* rebuild success rate
* ledger corruption incidents
* graph corruption recovery time

## 16. Rollout plan

## Phase 1: Alpha

Ship:

* native plugin install
* canonical ledger
* graph store
* `workflow_state`
* `workflow_next`
* `workflow_status`
* local CLI
* rebuild and doctor
* tool/browser/automation event capture
* advisory mode off by default

## Phase 2: Beta

Ship:

* `workflow_risks`
* `workflow_recall`
* better case splitting
* scope rules
* stateless/ignore patterns
* advisory mode opt-in
* HTTP daemon mode
* richer status diagnostics

## Phase 3: GA

Ship:

* advisory mode on by default
* MCP stdio and HTTP
* SDK
* import/export tools
* stronger custom taxonomy support
* cross-case analytics commands

## Phase 4: Sleep Cycle — Batch Consolidation & Enrichment

### 4.1 Motivation

Phases 1–3 capture events with minimal classification: tool names are mapped to coarse families (`tool`, `web`, `browser`, `automation`) via keyword matching, and all user messages land as a flat `message.user.inbound` type. This is fast and zero-latency, but the resulting graph is shallow — it models LLM execution mechanics (tool.started → tool.succeeded) rather than human workflow patterns.

Real procedural memory requires understanding **what the user intended**, not just what the agent executed. But inline LLM classification at capture time adds latency and cost to every turn. The solution is **batch consolidation** — a periodic "sleep cycle" that replays raw events, enriches them with LLM-derived classification, and rebuilds the graph with a richer taxonomy.

This mirrors biological memory consolidation: raw experience is captured fast during waking hours, then replayed and organized during sleep.

### 4.2 Architecture

**Two-phase event lifecycle:**

1. **Awake (capture):** Events are written to the ledger with keyword-based classification. Zero LLM calls. This is the existing pipeline — unchanged.
2. **Sleep (consolidation):** A batch job reads unconsolidated events, classifies user messages and tool sequences via LLM, enriches event types in-place, and triggers `rebuild()` with the richer taxonomy.

**New engine method:** `consolidate(options)`

```
consolidate({
  provider?: string;          // LLM provider (default: cheapest available)
  model?: string;             // Model override
  batchSize?: number;         // Events per LLM call (default: 50)
  dryRun?: boolean;           // Preview enrichments without writing
  reclassify?: boolean;       // Re-process already-consolidated events
  rebuild?: boolean;          // Trigger rebuild() after consolidation (default: true)
})
```

### 4.3 Enrichment taxonomy

**User message classification** (`message.user.inbound` → enriched type):

| Dimension | Values | Example |
|-----------|--------|---------|
| Intent | `command`, `question`, `correction`, `followup`, `escalation`, `approval`, `rejection` | `message.user.command` |
| Domain | `code`, `research`, `ops`, `communication`, `home`, `finance`, `health`, `creative` | label: `domain:code` |
| Session shape | `exploration`, `execution`, `debugging`, `review`, `planning` | label: `session-shape:debugging` |

**Tool type enrichment** (`tool.started` → hierarchical type):

| Level | Example | When used |
|-------|---------|-----------|
| Family | `tool.started` | Fallback when specific type has < minSupport |
| Specific | `tool.read.started`, `tool.exec.started` | Primary when sufficient support exists |

The graph stores edges at both levels. At query time, the engine tries specific first and falls back to family — extending the existing variable-order suffix fallback to type granularity.

**Feedback signals** (new event types):

| Type | Trigger |
|------|---------|
| `feedback.accepted` | User proceeds without correction after agent output |
| `feedback.corrected` | User immediately corrects or rephrases |
| `feedback.pivoted` | User changes direction entirely |
| `feedback.escalated` | User asks for a different approach |

### 4.4 Consolidation pipeline

1. Read events from ledger where `meta.consolidated != true`
2. Group events into windows (by case, chronological)
3. For each window, build an LLM prompt with the event sequence + surrounding context
4. LLM returns structured output: enriched type, intent, domain, feedback classification
5. Update events in ledger: set enriched `type`, add labels, set `meta.consolidated = true`, record `meta.consolidatedAt` and `meta.consolidationModel`
6. After all windows processed, trigger `rebuild()` to recompute graph with enriched types

**LLM prompt contract (structured output):**

```json
{
  "enrichments": [
    {
      "eventId": "...",
      "enrichedType": "message.user.command.code",
      "intent": "command",
      "domain": "code",
      "sessionShape": "execution",
      "feedbackSignal": null,
      "confidence": 0.92
    }
  ]
}
```

### 4.5 Scheduling

| Trigger | Description |
|---------|-------------|
| CLI | `sherpa consolidate` — manual one-shot |
| Cron | Nightly at 3 AM (configurable) |
| OpenClaw heartbeat | Batch into existing heartbeat check when > N unconsolidated events |
| Post-session | Optionally trigger after session end (configurable, off by default) |

### 4.6 Cost model

At current rates (Haiku/Flash-class models):
- ~$0.02 per 1,000 events classified
- Full 29K event corpus: ~$0.60
- Nightly run on typical day (200–500 events): < $0.01

### 4.7 Reclassification

When the taxonomy evolves (new intent types, refined domains), run `consolidate({ reclassify: true })` to reprocess all events. The LLM re-classifies with the updated prompt, and `rebuild()` recomputes the full graph. Previous classifications are overwritten — the ledger stores the enriched type, not the original, but `meta.originalType` preserves the raw classification for audit.

### 4.8 Success criteria

- Prediction accuracy on enriched graph > 75% (vs 62.6% on coarse types)
- Advisories reference user intent patterns, not just tool sequences
- Consolidation completes in < 5 minutes for a typical day's events
- Zero impact on capture-time latency

## Phase 5: Behavioral Model — Context Capture & Signal-Based Advisory

### 5.1 Motivation

Phases 1–4 build a procedural memory system that learns sequential patterns over typed events. But the abstractions baked into the API — "risk scores," "success rates," binary success/failure outcomes — impose value judgments the graph doesn't actually make.

The graph knows one thing: **after sequence X, Y happens with probability P, and the user responds with Z.** Everything else is interpretation. "Risk" is one lens, but the same data encodes:

- **Preferences**: "he usually wants the test written right after implementation"
- **Boundaries**: "he always pushes back when you refactor without asking"
- **Patience thresholds**: "he abandons this approach after 2 attempts and switches to manual"
- **Trust gradients**: "he corrects formatting but accepts logic"
- **Workflow rhythms**: "after research phases he likes a summary before action"

None of these are "risks." They're behavioral signals. And hardcoded pattern detectors (correction spiral, debug loop, missed step) are brittle — they engineer features the VOMM should discover on its own if the vocabulary is rich enough.

Phase 5 makes two changes:
1. **Capture conversational context at event time** so consolidation can produce rich behavioral classifications without depending on external systems
2. **Replace risk-centric APIs with raw signal APIs** that let an LLM interpreter decide what's worth surfacing in the current conversational context

### 5.2 Context capture at ingest

Add an optional `context` field to `SherpaEventSchema`:

```typescript
context?: {
  text?: string;       // truncated raw message or tool output (500 char cap)
  preceding?: string;  // last assistant response snippet (200 char cap)
  toolArgs?: string;   // summarized tool input for tool events (300 char cap)
}
```

The OpenClaw plugin already sees this data in its hooks:
- `before_prompt_build`: user message text → `context.text`
- `before_tool_call`: tool name + args → `context.toolArgs`
- `after_tool_call`: tool output snippet → `context.text`

Capture truncated snippets. This is classifier signal, not storage. Enough for an LLM to determine intent; small enough to not balloon the ledger.

**Ledger size impact**: ~700 bytes/event × typical corpus = manageable. Configurable via `capture.contextMaxChars` in plugin config.

**Privacy**: `context` capture respects the existing `ledger.redactRawText` flag. When true, `context` fields are omitted entirely. When false (opt-in), truncated snippets are stored.

### 5.3 Outcome tracking: user response as signal

Replace the binary `outcome: "success" | "failure"` model with **next-user-intent as outcome**.

The event *after* an agent action is the real signal:
- `user.approval` → agent got it right
- `user.correction` → agent got it wrong
- `user.pivot` → user changed direction
- `user.escalation` → user lost patience
- `user.abandonment` → user gave up
- `user.followup` → user wants more

The graph learns transition → user_response distributions at each state edge, not success/failure binaries. This happens naturally when consolidation enriches user message types with intent classification.

### 5.4 API refactor: `workflowSignals()`

Replace `workflowRisks()` and restructure `workflowNext()` into a single unified signal API:

```typescript
workflowSignals(options?: { caseId?: string; limit?: number }): Signal[]
```

Where `Signal` is:

```typescript
{
  state: string[];              // current state sequence
  prediction: string;           // most likely next event type
  probability: number;          // raw transition probability
  support: number;              // historical case count
  userResponseDist: Record<string, number>;  // { correction: 0.4, approval: 0.3, pivot: 0.2 }
  basis: {                      // historical evidence
    caseId: string;
    context?: string;           // context.text from the historical event
  }[];
}
```

No judgment. No "risk score." Raw behavioral signals with evidence.

**Backward compatibility**: `workflowNext()` remains as a convenience wrapper that returns the top predictions from `workflowSignals()`. `workflowRisks()` is deprecated — callers should use `workflowSignals()` and let the advisory interpreter handle framing.

### 5.5 Advisory interpreter

Replace hardcoded advisory templates with an LLM interpreter.

When `before_prompt_build` fires:
1. Call `workflowSignals()` for the current case
2. If any signal has high confidence + clear user response pattern, make one LLM call
3. LLM receives: current signals + current conversation context (from the hook's message array)
4. LLM decides: is anything worth surfacing? How to frame it?
5. Output injected as advisory, or suppressed entirely

The LLM might produce:
- "He prefers tests right after implementation" (preference)
- "Last 2 times you hit repeated corrections on config files, the root cause was env variable mismatch" (historical pattern with resolution)
- "Skip the explanation, he just wants the code" (communication style)
- Nothing at all (signals aren't actionable right now)

**Cost**: Advisory fires are rare (19/29K events in corpus). One cheap LLM call per fire. Negligible.

**Fallback**: If no LLM is available, advisory falls back to a template-based format using the raw signal data (prediction + probability + support). Functional but less nuanced.

### 5.6 Schema changes

**New**: `context` column on events table (TEXT, nullable). Migration via existing `ensureColumn()` pattern.

**Deprecated**: `risk_metrics` and `success_metrics` materialized tables. Replaced by `userResponseDist` computed from enriched state edges during `rebuild()`.

**Modified**: `state_edges` gains a `response_dist` column (JSON TEXT) storing the distribution of user response intents that follow each transition.

### 5.7 What gets deleted

- `risk_metrics` / `success_metrics` tables (replaced by response distributions on edges)
- `workflowRisks()` method (deprecated, wrapper over `workflowSignals()`)
- Hardcoded advisory cooldown logic (LLM interpreter handles relevance)
- `collectMetrics()` in current form (replaced by signal-based analytics)
- Binary success/failure outcome tracking (replaced by user response distributions)

### 5.8 What stays

- VOMM graph engine (untouched — same n-gram suffix matching, richer alphabet)
- Ledger / event ingest pipeline (extended with context field)
- Case management
- Consolidation infrastructure (upgraded classifier prompt with context)
- Export/import
- MCP + CLI + SDK transports
- `workflowState()`, `workflowNext()`, `workflowRecall()`, `workflowStatus()`

### 5.9 Success criteria

- Event type vocabulary expands from ~7 types to 30–50 enriched types after consolidation
- Prediction accuracy on intent sequences > 75% (vs 62.6% baseline on tool-only types)
- Manual audit of 10 generated advisories: majority rated "actionable" by user
- Advisories reference user behavioral patterns, not just tool sequences
- No regression in capture-time latency (context capture adds < 1ms)
- `workflowSignals()` returns meaningful `userResponseDist` for > 50% of high-support states

## 17. Risks

### 17.1 Event typing noise

If event normalization is poor, graph quality collapses.

Mitigation:

* start with tool and automation events
* keep message-derived events conservative
* expose custom rule overrides
* validate event alphabets against cardinality and drift metrics

### 17.2 State explosion

Too many event types or too high order creates sparse unusable graphs.

Mitigation:

* bounded event alphabet
* variable-order backoff
* event taxonomy discipline
* collapse low-support states
* allow hierarchical typing so long-range memory can use coarser states

### 17.3 Advice overfitting

Frequent paths may be bad paths.

Mitigation:

* store success and failure metrics separately
* never rank by frequency alone
* preserve exploration outside graph candidates
* distinguish predictive advice from policy choice in the final action layer

### 17.4 Privacy leakage

Procedural memory could surface sensitive workflow info in the wrong context.

Mitigation:

* DM-only default
* scope rules
* redaction by default
* stateless session support

### 17.6 Retrieval mismatch with semantic memory

If Sherpa is used as a substitute for semantic recall, it will perform badly on fact lookup and document retrieval.

Mitigation:

* keep Sherpa positioned as workflow memory only
* preserve native coexistence with QMD and Markdown memory
* route procedural questions to suffix-graph retrieval and factual questions to semantic retrieval

### 17.5 User confusion

Users may not understand how Sherpa differs from QMD or Lossless Claw.

Mitigation:

* position clearly:

  * QMD = document memory
  * Lossless Claw = conversation memory
  * Sherpa = workflow memory

## 18. Open questions

1. Should auto advisory ship disabled by default for the first public beta?
2. Should we capture message-derived events in v1, or only tool and automation events?
3. Should case identity default to session key only, or try to split by task automatically?
4. Do we want shared graph learning across agents on one machine in v2?
5. Should Sherpa support recommending actual OpenClaw tool names in `workflow_next`, or only event classes at first?
6. Do we want a small rules editor for custom event normalization in the plugin UI?
7. What should the first variable-order backoff policy be: simple minimum-support suffix fallback, or a richer mixture over suffix orders?
8. How should we validate normalization quality and event-alphabet drift in alpha?

## 19. Final recommendation

Build **Sherpa** as:

* a **native OpenClaw plugin** for install, config, event capture, and tool registration
* a **local sidecar core** for graph storage and fast procedural queries
* an **append-only event ledger** as source of truth
* a **derived SQLite graph** for variable-order workflow memory
* **bounded native tools** plus optional advisory injection
* **optional MCP and SDK** for reuse outside OpenClaw

That is the closest match to the integration style that already works:

* Lossless Claw shows how to feel native as a plugin
* QMD shows how to run a local sidecar with background sync, reusable surfaces, and graceful fallback. ([GitHub][1])

The result is a system that fits OpenClaw the way those tools do, but fills a distinct gap: **procedural memory of how workflows actually unfold**.

The next best step is to turn this into an engineering breakdown with package boundaries, command specs, and milestone tickets.

[1]: https://github.com/Martian-Engineering/lossless-claw "https://github.com/Martian-Engineering/lossless-claw"
[2]: https://openclawlab.com/en/docs/concepts/memory/ "https://openclawlab.com/en/docs/concepts/memory/"
[3]: https://github.com/tobi/qmd "https://github.com/tobi/qmd"
