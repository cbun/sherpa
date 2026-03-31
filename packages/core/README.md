# @sherpa/core

Sherpa's core ledger and workflow graph engine.

## Install

```bash
npm install @sherpa/core
```

## What It Provides

- append-only canonical event ingestion
- rebuildable derived workflow graph
- `workflowState`, `workflowNext`, `workflowRisks`, and `workflowRecall`
- status, doctor, export, and gc maintenance primitives

## Basic Use

```ts
import { SherpaEngine } from "@sherpa/core";

const engine = new SherpaEngine({
  rootDir: "./.sherpa"
});

await engine.ingest({
  caseId: "case-123",
  source: "tool.docs",
  type: "docs.requested",
  outcome: "success"
});

const next = await engine.workflowNext("case-123");
```

Node 22+ is required because the current storage backend uses `node:sqlite`.
