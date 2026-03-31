# @sherpa/openclaw

Sherpa's native OpenClaw plugin.

## Install

```bash
openclaw plugins install @sherpa/openclaw
```

## What It Does

- captures OpenClaw session, dispatch, and tool lifecycle events
- routes them into Sherpa's local ledger and graph
- exposes native workflow tools such as `workflow_state` and `workflow_next`
- can run embedded, CLI subprocess, or managed HTTP daemon transports

See the root repository README for the broader architecture and local setup.
