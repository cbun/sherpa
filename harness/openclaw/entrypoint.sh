#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_HOME="${OPENCLAW_HOME:-/home/openclaw}"
export OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-${OPENCLAW_HOME}/.openclaw}"
export HOME="${HOME:-${OPENCLAW_HOME}}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-sherpa-harness-token}"

cd /workspace

node /workspace/harness/openclaw/bootstrap-config.mjs

pnpm exec openclaw plugins install --link /workspace/packages/openclaw
pnpm exec openclaw plugins list >/dev/null

exec pnpm exec openclaw gateway run \
  --allow-unconfigured \
  --force \
  --port "${OPENCLAW_GATEWAY_PORT}" \
  --token "${OPENCLAW_GATEWAY_TOKEN}"
