# sherpa

Sherpa's command-line interface.

## Install

```bash
npm install --global sherpa
```

## Common Commands

```bash
sherpa --root ./.sherpa status
sherpa --root ./.sherpa workflow-state --case-id case-123
sherpa --root ./.sherpa workflow-next --case-id case-123
sherpa --root ./.sherpa serve --host 127.0.0.1 --port 8787
sherpa validate --dataset fixtures/validation/synthetic-workflows.json --top-k 3
```

The CLI wraps the same engine used by the SDK, MCP server, and OpenClaw plugin.
