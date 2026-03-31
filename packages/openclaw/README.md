# @sherpa/openclaw

Sherpa for OpenClaw.

This plugin gives OpenClaw a local memory for workflow patterns, not just facts or chat history.

## Install

```bash
openclaw plugins install @sherpa/openclaw
```

## Overview

- local workflow memory
- next-step suggestions
- risk warnings for paths that often fail or stall
- recall of similar past flows
- automatic event capture from normal OpenClaw use

## Minimal Config

Use embedded mode first:

```json
{
  "plugins": {
    "entries": {
      "sherpa": {
        "enabled": true,
        "config": {
          "transport": {
            "mode": "embedded"
          }
        }
      }
    }
  }
}
```

Sherpa will then store its data locally under:

```text
~/.openclaw/agents/{agentId}/sherpa
```

## Common Tools

- `workflow_status`
- `workflow_next`
- `workflow_risks`
- `workflow_recall`
- `workflow_taxonomy`
- `workflow_analytics`

## Default Posture

- leave raw text redaction on
- limit scope to direct messages and DMs unless you have a reason to widen it
- start with embedded transport

## Example Config

A fuller example lives at [`../../docs/examples/openclaw-sherpa.config.json`](../../docs/examples/openclaw-sherpa.config.json).

## Further Reading

For the full product README, setup guidance, and examples, see the root [`README.md`](../../README.md).
