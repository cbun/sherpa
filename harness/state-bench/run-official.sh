#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

STATE_BENCH_DIR="${STATE_BENCH_DIR:-}"
if [[ -z "${STATE_BENCH_DIR}" ]]; then
  echo "STATE_BENCH_DIR is required" >&2
  exit 1
fi

LEARNINGS_PATH="${SHERPA_STATE_BENCH_LEARNINGS:-${ROOT_DIR}/artifacts/state-bench/sherpa-learnings.json}"
OUTPUT_ROOT="${STATE_BENCH_OUTPUT_ROOT:-${ROOT_DIR}/artifacts/state-bench/official}"
AGENT_MODEL_NAME="${STATE_BENCH_AGENT_MODEL_NAME:-gpt-5.5}"
AGENT_REASONING="${STATE_BENCH_AGENT_REASONING:-high}"
NUM_RUNS="${STATE_BENCH_NUM_RUNS:-5}"
NUM_WORKERS="${STATE_BENCH_NUM_WORKERS:-2}"
TOP_K="${STATE_BENCH_RETRIEVE_TOP_K:-3}"
DOMAINS="${STATE_BENCH_DOMAINS:-travel customer_support shopping_assistant}"

mkdir -p "${STATE_BENCH_DIR}/agents" "${OUTPUT_ROOT}"
mkdir -p "${STATE_BENCH_DIR}/clients"
cp "${ROOT_DIR}/harness/state-bench/agents/sherpa_memory_agent.py" "${STATE_BENCH_DIR}/agents/sherpa_memory_agent.py"
cp "${ROOT_DIR}/harness/state-bench/agents/openclaw_json_agent.py" "${STATE_BENCH_DIR}/agents/openclaw_json_agent.py"
cp "${ROOT_DIR}/harness/state-bench/clients/openclaw_codex_client.py" "${STATE_BENCH_DIR}/clients/openclaw_codex_client.py"

if [[ ! -f "${LEARNINGS_PATH}" ]]; then
  echo "Missing Sherpa learning artifact: ${LEARNINGS_PATH}" >&2
  echo "Run pnpm harness:statebench:build-learnings first." >&2
  exit 1
fi

cd "${STATE_BENCH_DIR}"

run_variant() {
  local domain="$1"
  local variant="$2"
  local out_dir="${OUTPUT_ROOT}/${variant}/${domain}/test_trajectories"
  local metrics_path="${OUTPUT_ROOT}/${variant}/${domain}/metrics.json"
  mkdir -p "${out_dir}" "$(dirname "${metrics_path}")"

  local args=(
    uv run python -m state_bench.scripts.run_batch
    --domain "${domain}"
    --agent-model-name "${AGENT_MODEL_NAME}"
    --agent-model-reasoning-level "${AGENT_REASONING}"
    --num-runs "${NUM_RUNS}"
    --retrieve-learnings-top-k "${TOP_K}"
    --num-workers "${NUM_WORKERS}"
    --output-dir "${out_dir}"
  )

  if [[ "${STATE_BENCH_AGENT_BACKEND:-openclaw}" == "openclaw" ]]; then
    args+=(--agent-client-class OpenClawCodexClient)
    if [[ "${variant}" == "sherpa" ]]; then
      args+=(--agent-class SherpaOpenClawMemoryAgent)
    else
      args+=(--agent-class OpenClawJsonAgent)
    fi
  elif [[ "${variant}" == "sherpa" ]]; then
    args+=(--agent-class SherpaMemoryAgent)
  fi

  echo "[state-bench] running ${variant} on ${domain}"
  if [[ "${variant}" == "sherpa" ]]; then
    SHERPA_STATE_BENCH_LEARNINGS="${LEARNINGS_PATH}" "${args[@]}"
  else
    "${args[@]}"
  fi

  echo "[state-bench] computing metrics for ${variant} on ${domain}"
  uv run python -m state_bench.scripts.compute_metrics \
    --domain "${domain}" \
    --results-dir "${out_dir}" \
    --num-runs "${NUM_RUNS}" \
    --save-filepath "${metrics_path}"
}

for domain in ${DOMAINS}; do
  run_variant "${domain}" baseline
  run_variant "${domain}" sherpa
done

echo "[state-bench] metrics written under ${OUTPUT_ROOT}"
