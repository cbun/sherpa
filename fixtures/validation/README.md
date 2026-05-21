# Validation Fixtures

Sherpa supports both the original event-sequence fixtures and a richer JSON schema for real-world trace evaluation.

## Event-Only Fixtures

These remain valid:

- JSON array of `SherpaEventInput`
- JSON object with `name`, optional `description`, and `cases`
- JSONL of `SherpaEventInput`
- CSV and XES imports

## Rich JSON Schema

Use the richer JSON object format when you want to preserve annotations that matter for real-world evaluation.

Top-level fields:

- `name`: dataset name
- `description`: optional description
- `schemaVersion`: optional schema version number
- `ontologyVersion`: optional ontology or projection taxonomy version
- `split`: optional fixed split, one of `train`, `dev`, or `test`
- `notes`: optional dataset-level notes
- `cases`: array of validation cases

Case fields:

- `caseId`: required case identifier
- `events`: required ordered array of `SherpaEventInput`
- `labels`: optional case-level labels
- `sourceTrace`: optional trace source identifier
- `annotations`: optional structured metadata

Supported `annotations` fields:

- `workflowClass`: high-level workflow grouping such as `incident-response`
- `taskBoundaries`: array of `{ startStep, endStep?, title?, reason? }`
- `blockers`: array of `{ step, type, detail?, resolved? }`
- `expectations.terminalOutcome`: expected case outcome
- `expectations.nextByStep`: array of `{ step, expectedNext?, expectedRisks?, note? }`
- `notes`: optional case-level notes

## Ordering Rules

- If events have parseable timestamps, Sherpa sorts them chronologically within a case.
- If timestamps are absent or incomplete, Sherpa preserves authored order.
- For real trace fixtures, prefer explicit timestamps whenever they are available.

## Purpose

The richer schema is intended to support evaluation beyond raw next-event prediction, including:

- task-boundary quality
- blocker recognition
- terminal-outcome consistency
- projected-state and semantic retrieval benchmarks
- support-density and graph-state growth tracking
- annotated risk precision and recall

## Evidence-Grade Splits

For research runs, use fixed train/dev/test files and follow [`annotation-guide.md`](./annotation-guide.md).

Seed files:

- [`openclaw-real-train.json`](./openclaw-real-train.json)
- [`openclaw-real-dev.json`](./openclaw-real-dev.json)
- [`openclaw-real-test.json`](./openclaw-real-test.json)

These seed files establish the layout only. They are not large enough to support scientific claims until populated with real held-out traces.
