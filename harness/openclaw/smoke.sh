#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/harness/openclaw/compose.yml"
HOST_AUTH_COMPOSE_FILE="${ROOT_DIR}/harness/openclaw/compose.host-auth.yml"
AGENT_ID="${SHERPA_HARNESS_AGENT_ID:-main}"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/home/openclaw/.openclaw}"
AGENT_MODE="${OPENCLAW_AGENT_MODE:-local}"
COMPOSE_ARGS=(-f "${COMPOSE_FILE}")

if [ "${OPENCLAW_COPY_HOST_AUTH:-0}" = "1" ]; then
  COMPOSE_ARGS+=(-f "${HOST_AUTH_COMPOSE_FILE}")
fi

docker compose "${COMPOSE_ARGS[@]}" up -d --build
docker compose "${COMPOSE_ARGS[@]}" exec -T openclaw pnpm exec openclaw gateway health

AGENT_ARGS=(--agent "${AGENT_ID}" --message "Read README.md and reply with only the first heading." --json --timeout 120)
if [ "${AGENT_MODE}" = "local" ]; then
  AGENT_ARGS=(--local "${AGENT_ARGS[@]}")
fi

docker compose "${COMPOSE_ARGS[@]}" exec -T openclaw pnpm exec openclaw agent "${AGENT_ARGS[@]}"
docker compose "${COMPOSE_ARGS[@]}" exec -T openclaw pnpm exec openclaw gateway call sherpa.workflow_status --params "{\"agentId\":\"${AGENT_ID}\"}"
docker compose "${COMPOSE_ARGS[@]}" exec -T openclaw node packages/cli/dist/index.js --root "${OPENCLAW_CONFIG_DIR}/agents/${AGENT_ID}/sherpa" workflow-status
