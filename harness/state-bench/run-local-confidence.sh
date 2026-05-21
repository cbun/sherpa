#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

STATE_BENCH_DIR="${STATE_BENCH_DIR:-}"
if [[ -z "${STATE_BENCH_DIR}" ]]; then
  echo "STATE_BENCH_DIR is required" >&2
  exit 1
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

mkdir -p "${STATE_BENCH_DIR}/agents" "${STATE_BENCH_DIR}/clients"
cp "${ROOT_DIR}/harness/state-bench/agents/sherpa_memory_agent.py" "${STATE_BENCH_DIR}/agents/sherpa_memory_agent.py"
cp "${ROOT_DIR}/harness/state-bench/agents/openclaw_json_agent.py" "${STATE_BENCH_DIR}/agents/openclaw_json_agent.py"
cp "${ROOT_DIR}/harness/state-bench/clients/openclaw_codex_client.py" "${STATE_BENCH_DIR}/clients/openclaw_codex_client.py"

LEARNINGS_PATH="${SHERPA_STATE_BENCH_LEARNINGS:-${ROOT_DIR}/artifacts/state-bench/sherpa-learnings.json}"
if [[ ! -f "${LEARNINGS_PATH}" ]]; then
  echo "Missing Sherpa learning artifact: ${LEARNINGS_PATH}" >&2
  echo "Run pnpm harness:statebench:build-learnings first." >&2
  exit 1
fi

cd "${STATE_BENCH_DIR}"
SHERPA_REPO_ROOT="${ROOT_DIR}" \
SHERPA_STATE_BENCH_LEARNINGS="${LEARNINGS_PATH}" \
uv run python -u "${ROOT_DIR}/harness/state-bench/run-local-confidence.py" "$@"
