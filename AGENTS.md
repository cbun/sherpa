# AGENTS.md

## Purpose

Sherpa is a local-first procedural memory engine for OpenClaw.

The core idea is:

- the append-only event ledger is the source of truth
- the workflow graph is derived and rebuildable
- retrieval should stay deterministic, bounded, and inspectable
- OpenClaw integration should be an adapter over the core, not where workflow logic lives

## Repository Map

- `packages/core`: canonical engine implementation
- `packages/cli`: thin CLI wrapper over `@sherpa/core`
- `packages/openclaw`: native OpenClaw plugin adapter over `@sherpa/core`
- `packages/sdk`: Node/Bun SDK wrapper over `@sherpa/core`
- `packages/mcp`: MCP stdio and HTTP server over `@sherpa/sdk`
- `prd/sherpa-prd.md`: product and architecture source of truth
- `docs/research.pdf`: research background for the higher-order workflow model

## Working Rules

- Keep procedural reasoning in `packages/core`.
- Keep `packages/cli` thin. Prefer adding capabilities to the core first, then exposing them in the CLI.
- Treat the ledger as canonical. Never make the graph store the only copy of history.
- Prefer rebuildability over clever incremental state if the tradeoff is unclear.
- Preserve local-first behavior. Do not introduce outbound network dependencies into core graph logic.
- Keep event types bounded and operational. Do not let canonical state identity depend on free-form text.
- Favor inspectable outputs: support counts, matched order, probabilities, outcomes, freshness.

## Current Core Surface

The standalone core is expected to support:

- ingesting canonical events
- rebuilding the graph from the ledger
- workflow state lookup
- workflow next-step prediction
- workflow risk detection
- workflow recall
- status and doctor checks
- export and gc maintenance commands

If adding new features, prefer extending this surface before building plugin-only behavior.

## OpenClaw Integration Guidance

When `@sherpa/openclaw` is added:

- keep it as a native adapter layer for install, event capture, tool registration, and advisory injection
- do not duplicate workflow inference logic in the plugin
- prefer shelling out to the local core or importing stable SDK surfaces once they exist
- keep graceful fallback behavior explicit

## Commands

Use these as the default verification commands:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For CLI smoke checks:

```bash
node packages/cli/dist/index.js --root ./.sherpa status
node packages/cli/dist/index.js --root ./.sherpa workflow-status
```

## Git and Commits

- Use conventional commit messages.
- Prefer scopes when useful, for example:
  - `feat(core): ...`
  - `fix(cli): ...`
  - `docs(readme): ...`
  - `test(core): ...`

## Documentation Expectations

- If behavior changes, update `README.md` when the user-facing CLI or architecture description changes.
- If product assumptions change, update `prd/sherpa-prd.md`.
- If implementation diverges from the PRD, either reconcile it or document the divergence explicitly.
