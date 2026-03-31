# Sherpa

Sherpa is a procedural memory layer for OpenClaw.

Rather than storing only facts or whole conversations, it models recurring workflow structure:

- what usually comes next
- where tasks often get stuck
- which paths tend to end successfully

It runs locally, watches the workflow events OpenClaw already produces, and derives a compact process memory from them.

The problem it is trying to solve is simple:
as OpenClaw sessions grow longer, useful procedural context is often mixed together with too much conversational surface area.
That makes next-step guidance brittle. Context gets compacted, sessions restart, summaries drift, and the model is left to reconstruct the shape of the work from a noisy partial trace.

## Procedural Memory

OpenClaw is already good at acting inside the current turn.
Sherpa is concerned with continuity across turns and across sessions.

In practice that means:

- suggest likely next steps for the task it is currently in
- warn when a path often leads to failure or stalls
- recall similar past task flows
- keep this memory on your machine instead of sending it to a remote service

## In Practice

You ask OpenClaw to work on something.
Sherpa quietly watches the flow.
Later, on a similar task, Sherpa can say:

- "This usually goes: inspect repo -> patch -> test -> complete."
- "This branch often gets blocked after env checks."
- "The last successful cases took a different path."

It is not trying to be magic.
It is trying to be useful, local, and explainable.

## System Sketch

```mermaid
flowchart LR
  subgraph OC["OpenClaw"]
    A["Session and messages"]
    B["Tool calls and results"]
    C["Task boundaries and outcomes"]
  end

  subgraph PL["Sherpa plugin"]
    D["Scope rules and redaction"]
    E["Case routing"]
    F["Typed event normalization"]
  end

  subgraph ST["Local Sherpa store"]
    G["Append-only event ledger"]
    H["Derived workflow graph"]
  end

  subgraph RT["Runtime queries"]
    I["workflow_state"]
    J["workflow_next"]
    K["workflow_risks"]
    L["workflow_recall"]
  end

  A --> D
  B --> D
  C --> D
  D --> E --> F --> G
  G --> H
  H --> I
  H --> J
  H --> K
  H --> L
```

Sherpa is local-first.
Its working memory is built from typed events such as session starts, messages, tool calls, task boundaries, and task endings.

## Observed Failure Modes

Sherpa is aimed at a fairly specific class of failure in long-running agent sessions.

OpenClaw's own memory troubleshooting material explicitly calls out:

- context overflow and aggressive compaction
- loss of context mid-conversation or after gateway restarts
- memory logs not being written reliably when gateway or filesystem conditions are wrong
- conflicts between some memory features and other interaction modes such as voice

Public bug reports show another adjacent failure mode: state from one session can leak into the next. For example, issue `#58353` reports stale system-summary text being prepended to the first message of a new session after `/new` or `/reset`.

Sherpa does not solve provider outages, gateway crashes, or transport bugs by itself.
What it does is move one important class of memory away from the most brittle substrate.
Instead of asking the model to carry the whole conversational surface in its prompt, Sherpa learns a smaller procedural trace outside the prompt itself.

More concretely, Sherpa is intended to mitigate these pressures:

- compaction pressure: a short typed event path is much cheaper to preserve than a fully expanded conversation
- session contamination: case routing gives memory a narrower unit than "whatever was most recently in context"
- brittle long-horizon continuity: an append-only local ledger survives beyond any single prompt window and can be rebuilt into the same workflow graph
- semantic overreach: next-step guidance is drawn from bounded observed continuations, not an unrestricted retrieval space

Selected sources:

- [OpenClaw memory troubleshooting guide](https://www.getopenclaw.ai/help/memory-search-setup-guide)
- [OpenClaw issue #58353](https://github.com/openclaw/openclaw/issues/58353)
- [OpenClaw issue tracker](https://github.com/openclaw/openclaw/issues)

## Using Sherpa With OpenClaw

### 1. Install the plugin

Sherpa is not yet published to the plugin registry. Install from a local build:

```bash
cd sherpa
pnpm install && pnpm build

# then link or point OpenClaw at the local package
openclaw plugins install --local ./packages/openclaw
```

### 2. Add a small config block

Copy this into your OpenClaw plugin config for `sherpa`:

```json
{
  "plugins": {
    "entries": {
      "sherpa": {
        "enabled": true,
        "config": {
          "transport": {
            "mode": "embedded"
          },
          "advisory": {
            "enabled": true,
            "injectThreshold": 0.75
          },
          "scope": {
            "default": "deny",
            "rules": [
              { "action": "allow", "match": { "chatType": "direct" } },
              { "action": "allow", "match": { "chatType": "dm" } }
            ]
          }
        }
      }
    }
  }
}
```

A ready-to-copy example also lives at [`docs/examples/openclaw-sherpa.config.json`](./docs/examples/openclaw-sherpa.config.json).

### 3. Restart OpenClaw

That is enough to get Sherpa running.

By default, Sherpa stores data under:

```text
~/.openclaw/agents/{agentId}/sherpa
```

## Conservative Defaults

For most people, start with:

- `transport.mode = embedded`
- advisory enabled
- scope limited to direct messages and DMs
- raw text redaction left on

That gives you the easiest setup and the safest privacy posture.

## A Minimal Example

Without Sherpa:

- OpenClaw handles each task on its own

With Sherpa:

- OpenClaw can recognize "this looks like the same sort of task as before"
- it can suggest the next likely move
- it can warn when a branch often leads to blockage
- it can recall how successful cases finished

## What It Actually Feels Like

Think about how a good human assistant learns your habits.

After a few weeks, they don't just do what you ask — they anticipate.
They remember that you always want coffee before the 9am call, not because you told them a rule, but because they watched it happen five times.
They remember that last time you tried to book a restaurant the day-of, it didn't work out, so now they nudge you to book earlier.
They're not smarter than they were on day one. They just have *muscle memory* for how your work tends to go.

That's what Sherpa gives OpenClaw.

### Without Sherpa

You say: "I have a call with Acme Corp in an hour, help me prep."

OpenClaw checks your calendar, drafts some talking points. Fine.

Next week, different company, same ask. It starts from scratch. Doesn't remember that last time you also wanted the most recent email thread pulled. Doesn't remember you always prefer bullets over paragraphs. Doesn't know that 4 out of 5 times, you follow up with "what did we discuss last time?" — something it could have just done upfront.

Every meeting prep is day one.

### With Sherpa

After a handful of meeting preps, Sherpa has seen the workflow shape:

`calendar-check → email-search → prior-notes → talking-points → summary`

It has also noticed that when it *skips* the email search, you come back and ask for it most of the time. That's a stall pattern.

So now when you say "prep me for the Acme call," the advisory injects:

> *Meeting prep flows typically follow: calendar → recent emails → prior notes → talking points. Skipping email lookup leads to a follow-up request 4 out of 5 times. Last 3 successful preps averaged 2 minutes.*

OpenClaw now front-loads the email pull and the prior context without you asking.

It learned your **process**, not your **facts**. That distinction matters. Facts change, but the shape of how you work is remarkably stable — and remarkably useful once something is paying attention to it.

The same thing applies to anything you do repeatedly: research tasks, weekly reviews, trip planning, inbox triage. Sherpa turns your habits into guardrails.

## OpenClaw Tools

After install, Sherpa adds these OpenClaw tools:

- `workflow_status`
- `workflow_state`
- `workflow_next`
- `workflow_risks`
- `workflow_recall`
- `workflow_taxonomy`
- `workflow_analytics`
- `workflow_doctor`
- `workflow_rebuild`
- `workflow_export`
- `workflow_import`
- `workflow_gc`
- `workflow_ingest_event` *(optional — manual event injection)*

The most useful ones for day-to-day use are:

- `workflow_next`: what usually comes next from here
- `workflow_risks`: where this path often fails or stalls
- `workflow_recall`: similar past paths and how they continued
- `workflow_status`: whether Sherpa is healthy and capturing properly

## Transport Modes

### Simple local setup

Use embedded mode when you want the least setup:

```json
{
  "transport": {
    "mode": "embedded"
  }
}
```

### CLI subprocess mode

Use this if you want the plugin to shell out to the `sherpa` CLI:

```json
{
  "transport": {
    "mode": "stdio",
    "command": "sherpa"
  }
}
```

### Managed HTTP daemon

Use this if you want a warm local process managed by the plugin:

```json
{
  "transport": {
    "mode": "http",
    "baseUrl": "http://127.0.0.1:8787",
    "manageProcess": true
  }
}
```

## Local First

Sherpa is designed to be conservative by default.

- it stores data locally
- raw message text is redacted by default
- scope defaults to deny unless allowed by rules
- you can ignore session patterns entirely
- you can mark some sessions as stateless

If you want Sherpa to remember less, tighten scope rules first.

## Process View

```mermaid
flowchart TD
  A["Recent typed event suffix
  inspect -> patch -> test"] --> B["Current workflow state"]

  B --> C["Observed continuation:
  complete
  support: high
  success rate: high"]

  B --> D["Observed continuation:
  env-check
  support: medium
  stall rate: elevated"]

  B --> E["Observed continuation:
  rewrite
  support: low
  failure rate: elevated"]

  C --> F["Sherpa can rank likely next steps"]
  D --> G["Sherpa can warn about risky branches"]
  E --> H["Sherpa can recall similar bad endings"]
```

## Mechanism and Theory

Sherpa can be described, a little loosely, as a procedural memory layer for OpenClaw.

It does not try to answer "what do I know about this topic?" and it does not mainly try to answer "what was said before?"
It is closer to:

- what path are we on
- what usually follows this path
- which branches tend to resolve well
- which branches tend to fail or go quiet

This is one answer to a recurring tension in agent systems:
semantic memory is often too broad for moment-to-moment workflow steering, while raw conversation history is too expensive and fragile to carry indefinitely.

The internal model is intentionally structured rather than fuzzy.
Sherpa keeps an append-only local event ledger, then derives a workflow graph from those events.
Recent event suffixes act as the current state; observed continuations become candidate next moves.

Later theory for this project comes from a mix of:

- higher-order Markov models
- de Bruijn-style overlap ideas
- process mining
- graph-shaped memory systems

That academic background matters mostly because it shapes the retrieval behavior:

- advice stays bounded to plausible next branches instead of searching an endless memory space
- repeated workflow phases compress into reusable paths
- suggestions can be explained with support, success, failure, and timing rather than only vague similarity

The design hypothesis is that this changes the failure surface in a useful way:

- if the prompt must be compacted, the learned workflow trace can still persist outside the prompt
- if a session is restarted, the durable ledger still preserves the path that was taken
- if the recent chat surface is noisy, retrieval can still operate over typed transitions rather than raw text similarity
- if memory grows large, bounded event types and typed transitions keep retrieval closer to a process model than a free-form note pile

Sherpa is predictive, not oracular.
It notices regularities in how work tends to unfold.

## For Power Users

Sherpa also ships with:

- a CLI package: [`packages/cli`](./packages/cli)
- an OpenClaw plugin package: [`packages/openclaw`](./packages/openclaw)
- an SDK: [`packages/sdk`](./packages/sdk)
- an MCP server: [`packages/mcp`](./packages/mcp)

If you want the research background, see [`docs/research.pdf`](./docs/research.pdf).

The product spec is kept locally and is not checked into the repository.

## Local Development

```bash
pnpm install
pnpm build
pnpm test
pnpm validate-suite --input fixtures/validation/suite.json --max-failing-datasets 10
```

Useful local commands:

```bash
node packages/cli/dist/index.js --root ./.sherpa status
node packages/cli/dist/index.js --root ./.sherpa workflow-next --case-id case-123
node packages/cli/dist/index.js --root ./.sherpa workflow-risks --case-id case-123
node packages/cli/dist/index.js --root ./.sherpa workflow-recall --case-id case-123 --mode successful
node packages/cli/dist/index.js --root ./.sherpa taxonomy-report --recent-days 14 --max-types 50 --max-drift-score 0.2
node packages/cli/dist/index.js --root ./.sherpa analytics-report --limit 10
```

## Current State

Sherpa is already usable and production-oriented, but it is still improving in one important area:
ranking quality.

The system already captures, stores, retrieves, and explains workflow memory well.
The main future gains are in making its suggestions even smarter as validation corpora grow.
