# STATE-Bench Harness

This harness is the SOTA-facing path for Sherpa.

STATE-Bench is a public benchmark from Microsoft for testing whether agentic memory improves stateful task completion, reliability, UX, and cost across travel, customer support, and shopping tasks. It exposes a narrow memory interface: build procedural learnings from train trajectories, then provide `retrieve_learnings(query, top_k)` during locked test runs.

Sherpa's current internal gate showed that graph next-step prediction is not yet better than strong sequence baselines. STATE-Bench gives us a stronger applied target: can Sherpa-derived procedural learnings improve full task outcomes under a public protocol?

## Sources

- [STATE-Bench blog](https://opensource.microsoft.com/blog/2026/05/19/introducing-state-bench-a-benchmark-for-ai-agent-memory/)
- [STATE-Bench repository](https://github.com/microsoft/STATE-Bench)
- [Agent Workflow Memory](https://proceedings.mlr.press/v267/wang25bx.html)
- [Memp: Exploring Agent Procedural Memory](https://arxiv.org/abs/2508.06433)
- [EvoMemBench](https://arxiv.org/abs/2605.18421)

## Build Sherpa Learnings

Clone STATE-Bench outside this repo, then build local Sherpa learning artifacts from its public train trajectories:

```bash
pnpm build
pnpm harness:statebench:build-learnings -- \
  --state-bench-dir /path/to/STATE-Bench \
  --output artifacts/state-bench/sherpa-learnings.json \
  --root artifacts/state-bench/sherpa-store \
  --reset
```

The builder:

- reads `datasets/train_task_trajectories/<domain>/*.json`
- projects each trajectory into canonical Sherpa events
- rebuilds a Sherpa graph store from the append-only ledger
- emits deterministic procedural learning cards, aggregate domain playbooks, and repeated-sequence recipes for STATE-Bench retrieval

## Run Free Local Confidence Checks

Before paying for the locked evaluator/simulator path, run a local confidence pass against public STATE-Bench task files:

```bash
STATE_BENCH_DIR=/path/to/STATE-Bench \
SHERPA_STATE_BENCH_LEARNINGS=<repo>/artifacts/state-bench/sherpa-learnings.json \
pnpm harness:statebench:local-confidence -- \
  --domains customer_support \
  --tasks 55-challenge_price_match_refund \
  --variant both
```

This path:

- uses your existing OpenClaw auth profile through `openclaw infer model run --gateway --model openai-codex/gpt-5.5`
- executes STATE-Bench domain tools canonically in the harness
- checks deterministic `state_requirements` without Azure evaluator credentials
- uses a simple scripted user that can provide the task's public `known_info`
- writes trajectories and `summary.json` under `artifacts/state-bench/local-confidence`

It is a cheap confidence gate, not an official benchmark score. It does not run the locked user simulator, task-requirements judge, UX judge, or official metric computation.

For the sandboxed OpenClaw path, use the Docker wrapper. It starts the OpenClaw harness container, mounts host OpenClaw auth read-only at `/host-openclaw`, and makes STATE-Bench call OpenClaw inside the container:

```bash
STATE_BENCH_DIR=/path/to/STATE-Bench \
SHERPA_STATE_BENCH_LEARNINGS=<repo>/artifacts/state-bench/sherpa-learnings.json \
OPENCLAW_COPY_HOST_AUTH=1 \
OPENCLAW_MODEL_PRIMARY=openai-codex/gpt-5.5 \
pnpm harness:statebench:local-confidence:docker -- \
  --domains customer_support \
  --tasks 55-challenge_price_match_refund \
  --variant both
```

Prefer the Docker wrapper for research evidence. The non-Docker wrapper is useful for quick debugging but uses the host OpenClaw executable and gateway directly.

Current Docker local-confidence reference runs:

- `artifacts/state-bench/docker-hard-support-v4`: customer-support hard slice, baseline 3/3 and Sherpa 3/3.
- `artifacts/state-bench/docker-hard-travel-v3`: travel hard slice, baseline 0/3 and Sherpa 3/3.

These are state-only local confidence runs, not official STATE-Bench scores.

Analyze a completed local confidence run:

```bash
pnpm harness:statebench:analyze -- \
  --input artifacts/state-bench/local-confidence \
  --output artifacts/state-bench/local-confidence/analysis.md
```

The analyzer reports paired baseline-vs-Sherpa state outcomes, tool-call deltas, tool-error deltas, memory calls, and infrastructure errors.

## Run STATE-Bench With Sherpa Memory

Copy or symlink the agent subclass into the root of a STATE-Bench checkout:

```bash
mkdir -p /path/to/STATE-Bench/agents
cp harness/state-bench/agents/sherpa_memory_agent.py /path/to/STATE-Bench/agents/
```

Then run STATE-Bench using its official workflow:

```bash
cd /path/to/STATE-Bench
SHERPA_STATE_BENCH_LEARNINGS=<repo>/artifacts/state-bench/sherpa-learnings.json \
uv run python -m state_bench.scripts.run_batch \
  --domain travel \
  --agent-class SherpaMemoryAgent \
  --agent-model-name gpt-5.1 \
  --agent-model-reasoning-level medium \
  --num-runs 5 \
  --retrieve-learnings-top-k 3 \
  --num-workers 2 \
  --output-dir outputs/travel/test_trajectories
```

Repeat for `customer_support` and `shopping_assistant`, then compute official metrics:

```bash
uv run python -m state_bench.scripts.compute_metrics \
  --domain travel \
  --results-dir outputs/travel/test_trajectories \
  --num-runs 5 \
  --save-filepath outputs/travel/metrics.json
```

The SOTA claim is only eligible if Sherpa beats the no-memory STATE-Bench baseline and competitive memory baselines on task completion or reliability without unacceptable UX or cost regression.

## One-Command Official Run

Once the locked STATE-Bench evaluator credentials and agent provider credentials are configured in the STATE-Bench checkout, run both no-memory and Sherpa-memory variants across all domains:

```bash
STATE_BENCH_DIR=/path/to/STATE-Bench \
STATE_BENCH_AGENT_MODEL_NAME=gpt-5.5 \
STATE_BENCH_AGENT_REASONING=high \
SHERPA_STATE_BENCH_LEARNINGS=<repo>/artifacts/state-bench/sherpa-learnings.json \
pnpm harness:statebench:official
```

The wrapper writes metrics under `artifacts/state-bench/official/{baseline,sherpa}/<domain>/metrics.json`.

By default this wrapper uses `STATE_BENCH_AGENT_BACKEND=openclaw`, which copies two STATE-Bench extensions into the checkout:

- `OpenClawCodexClient`, which calls `openclaw infer model run --gateway --model openai-codex/gpt-5.5`
- `OpenClawJsonAgent` / `SherpaOpenClawMemoryAgent`, which convert STATE-Bench tool schemas into strict JSON tool-call plans for the harness to execute

That path uses your existing OpenClaw auth profiles, including `openai-codex` OAuth, for the evaluated agent. STATE-Bench still needs its locked evaluator/simulator credentials for official scoring.

Useful OpenClaw-backed agent env vars:

- `SHERPA_OPENCLAW_MODEL`: default `openai-codex/gpt-5.5`
- `SHERPA_OPENCLAW_MODE`: default `gateway`; use `local` only if OpenClaw local inference works for the selected provider
- `SHERPA_OPENCLAW_CMD`: default `openclaw`
- `SHERPA_OPENCLAW_TIMEOUT_SECONDS`: default `240`
- `SHERPA_OPENCLAW_RETRIES`: default `2`, for transient gateway failures
- `SHERPA_OPENCLAW_RETRY_DELAY_SECONDS`: default `2`
- `STATE_BENCH_AGENT_BACKEND`: default `openclaw`; set to `state-bench-sdk` to use STATE-Bench's built-in OpenAI/Azure SDK agent path
