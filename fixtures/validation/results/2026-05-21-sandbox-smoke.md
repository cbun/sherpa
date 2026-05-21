# Sherpa Sandbox Smoke Report

## Run Metadata

- Date: 2026-05-21
- Git SHA: `e29c65a` plus the research-harness changes committed in this series
- Suite: `harness/openclaw/tasks/smoke-suite.json`
- Model: `openai-codex/gpt-5.5`
- Agent mode: OpenClaw gateway
- Host auth: copied from read-only `/host-openclaw`
- OpenClaw base image: `ghcr.io/openclaw/openclaw:2026.5.7`
- Shadow artifacts: `artifacts/openclaw-harness/shadow-smoke`
- Advisory artifacts: `artifacts/openclaw-harness/advisory-smoke`

## Commands

```bash
OPENCLAW_COPY_HOST_AUTH=1 \
OPENCLAW_MODEL_PRIMARY=openai-codex/gpt-5.5 \
OPENCLAW_AGENT_MODE=gateway \
SHERPA_HARNESS_COMPOSE_TIMEOUT_MS=900000 \
pnpm harness:openclaw:suite -- \
  --suite harness/openclaw/tasks/smoke-suite.json \
  --mode shadow \
  --results-dir artifacts/openclaw-harness/shadow-smoke
```

```bash
OPENCLAW_COPY_HOST_AUTH=1 \
OPENCLAW_MODEL_PRIMARY=openai-codex/gpt-5.5 \
OPENCLAW_AGENT_MODE=gateway \
SHERPA_HARNESS_COMPOSE_TIMEOUT_MS=900000 \
pnpm harness:openclaw:suite -- \
  --suite harness/openclaw/tasks/smoke-suite.json \
  --mode advisory \
  --results-dir artifacts/openclaw-harness/advisory-smoke
```

## Headline Result

The Docker/OpenClaw sandbox can run gateway-mode GPT-5.5 tasks with Sherpa loaded, capture workflow events into an isolated ledger, rebuild the graph, and export per-run artifacts without writing to the host OpenClaw install.

## Metrics

| Mode | Tasks | Failures | Final events | Final cases | Final states | Advisory enabled |
|---|---:|---:|---:|---:|---:|---|
| shadow | 2 | 0 | 6 | 2 | 14 | no |
| advisory | 2 | 0 | 12 | 2 | 30 | yes |

## Observations

- Sherpa is now loaded at gateway startup as the seventh runtime plugin.
- The suite runner waits until `sherpa.workflow_status` reports event-count growth after each task.
- Captured ledgers and graph stores live under `/home/openclaw/.openclaw/agents/main/sherpa` inside the disposable Docker volume.
- The sandbox uses a root-level OpenClaw package symlink outside the linked plugin path so plugin safety scanning does not see package-local `node_modules`.

## Claims

| Claim | Decision | Evidence | Next action |
|---|---|---|---|
| Docker sandbox does not touch host install | supported for smoke | fresh Docker volume plus read-only host-auth mount | keep using artifacts as non-canonical run evidence |
| GPT-5.5 gateway path works | supported for smoke | both modes completed 2/2 tasks with `openai-codex/gpt-5.5` | scale task suite |
| Sherpa captures real OpenClaw traces | supported for smoke | nonzero event/case/state counts in both modes | run 30-case pilot |
| Advisory improves behavior | pending | smoke suite only verifies non-harm on simple tasks | add paired no-memory/shadow/advisory tasks with repeated motifs |

## Follow-Up Work

1. Expand the sandbox task suite from 2 smoke tasks to a 30-case pilot.
2. Add paired `none`, `shadow`, and `advisory` reports to quantify behavior differences.
3. Add tasks with known recurring failure branches so advisory value can be measured.
