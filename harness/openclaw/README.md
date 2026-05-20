# OpenClaw Harness

This is an isolated OpenClaw test box for Sherpa.

It exists to answer one question cleanly:

- does the plugin capture, project, store, and retrieve workflow memory correctly without touching your personal `~/.openclaw` state?

## Default posture

- OpenClaw home lives in a Docker volume, not on the host
- Sherpa is linked from the checked-out repo inside the image
- the default build base is `ghcr.io/openclaw/openclaw:2026.5.7`; override with `SHERPA_HARNESS_BASE_IMAGE`
- the default model is `openai/gpt-5.4`, which works with an `OPENAI_API_KEY`
- the smoke test uses `openclaw agent --local` by default
- the container runtime user is root so fresh named volumes can be initialized without host permission coupling

## Codex note

`openai-codex/*` usually depends on OpenClaw auth state, not just a raw API key.

If you want the harness to exercise the same Codex-backed provider stack as your host OpenClaw install:

1. set `OPENCLAW_COPY_HOST_AUTH=1`
2. set `OPENCLAW_MODEL_PRIMARY=openai-codex/gpt-5.5` (or your preferred Codex model)
3. set `OPENCLAW_AGENT_MODE=gateway` so the smoke test uses the running gateway path instead of `--local`

When `OPENCLAW_COPY_HOST_AUTH=1` is set, the harness adds [`compose.host-auth.yml`](./compose.host-auth.yml), mounting host OpenClaw auth read-only at `/host-openclaw`.

## Research suite runner

For repeated sandbox tasks, use the suite runner:

```bash
OPENCLAW_COPY_HOST_AUTH=1 \
OPENCLAW_MODEL_PRIMARY=openai-codex/gpt-5.5 \
OPENCLAW_AGENT_MODE=gateway \
pnpm harness:openclaw:suite -- --suite harness/openclaw/tasks/smoke-suite.json --mode advisory
```

Supported modes:

- `none`: disable the Sherpa plugin
- `shadow`: capture/query path enabled, automatic advisory disabled
- `tool-only`: same as shadow for now; reserved for explicit tool-use studies
- `advisory`: automatic advisory enabled

The runner writes task results, workflow status, and an agent-state archive under `artifacts/openclaw-harness/<run-id>/`.

## Commands

From the repo root:

```bash
docker compose -f harness/openclaw/compose.yml up -d --build
bash harness/openclaw/smoke.sh
node harness/openclaw/run-suite.mjs --suite harness/openclaw/tasks/smoke-suite.json
docker compose -f harness/openclaw/compose.yml exec openclaw bash
docker compose -f harness/openclaw/compose.yml down -v
```
