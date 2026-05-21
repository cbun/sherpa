#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_BENCH_DIR="${STATE_BENCH_DIR:-}"
if [[ -z "${STATE_BENCH_DIR}" ]]; then
  echo "STATE_BENCH_DIR is required" >&2
  exit 1
fi

COMPOSE_FILE="${ROOT_DIR}/harness/openclaw/compose.yml"
HOST_AUTH_COMPOSE_FILE="${ROOT_DIR}/harness/openclaw/compose.host-auth.yml"
COMPOSE_ARGS=(-f "${COMPOSE_FILE}" -f "${HOST_AUTH_COMPOSE_FILE}")

export OPENCLAW_COPY_HOST_AUTH="${OPENCLAW_COPY_HOST_AUTH:-1}"
export OPENCLAW_MODEL_PRIMARY="${OPENCLAW_MODEL_PRIMARY:-openai-codex/gpt-5.5}"
export OPENCLAW_AGENT_MODE="${OPENCLAW_AGENT_MODE:-gateway}"
export SHERPA_HARNESS_MODE="${SHERPA_HARNESS_MODE:-advisory}"
export SHERPA_HARNESS_BASE_IMAGE="${SHERPA_HARNESS_BASE_IMAGE:-ghcr.io/openclaw/openclaw:2026.5.19}"
export SHERPA_OPENCLAW_MODEL="${SHERPA_OPENCLAW_MODEL:-${OPENCLAW_MODEL_PRIMARY}}"
export SHERPA_OPENCLAW_MODE="${SHERPA_OPENCLAW_MODE:-gateway}"
export SHERPA_OPENCLAW_RETRIES="${SHERPA_OPENCLAW_RETRIES:-4}"
export SHERPA_OPENCLAW_RETRY_DELAY_SECONDS="${SHERPA_OPENCLAW_RETRY_DELAY_SECONDS:-3}"
export SHERPA_OPENCLAW_CMD="${SHERPA_OPENCLAW_CMD:-openclaw}"
export SHERPA_OPENCLAW_CMD_PREFIX="docker compose -f ${COMPOSE_FILE} -f ${HOST_AUTH_COMPOSE_FILE} exec -T openclaw pnpm exec"

docker compose "${COMPOSE_ARGS[@]}" up -d --build

deadline=$((SECONDS + 180))
until docker compose "${COMPOSE_ARGS[@]}" exec -T openclaw pnpm exec openclaw gateway health >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "Dockerized OpenClaw gateway did not become healthy within 180s" >&2
    docker compose "${COMPOSE_ARGS[@]}" logs --tail=120 openclaw >&2 || true
    exit 1
  fi
  sleep 3
done

exec bash "${ROOT_DIR}/harness/state-bench/run-local-confidence.sh" "$@"
