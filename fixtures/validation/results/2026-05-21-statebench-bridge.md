# Sherpa STATE-Bench Bridge Report

## Run Metadata

- Date: 2026-05-21
- Benchmark target: [STATE-Bench](https://github.com/microsoft/STATE-Bench)
- STATE-Bench checkout used for local bridge validation: `/tmp/sherpa-state-bench`
- Learning artifact: `artifacts/state-bench/sherpa-learnings.json`
- Sherpa store: `artifacts/state-bench/sherpa-store`
- Agent adapter: `harness/state-bench/agents/sherpa_memory_agent.py`
- OpenClaw-backed agent adapter: `harness/state-bench/agents/openclaw_json_agent.py`
- OpenClaw-backed client: `harness/state-bench/clients/openclaw_codex_client.py`

## Why This Is The SOTA Path

STATE-Bench is a current public benchmark for agentic memory that evaluates whether memory improves task completion, reliability, UX, and cost across 450 tasks in travel, customer support, and shopping. It provides 300 public train trajectories and 150 locked test tasks, then asks memory systems to expose `retrieve_learnings(query, top_k)`.

This is a better SOTA target than Sherpa's internal next-step validation because it measures full task outcomes under a public protocol.

## Commands Run

```bash
pnpm harness:statebench:build-learnings -- \
  --state-bench-dir /tmp/sherpa-state-bench \
  --output artifacts/state-bench/sherpa-learnings-smoke.json \
  --root artifacts/state-bench/sherpa-store-smoke \
  --max-per-domain 2 \
  --reset
```

```bash
pnpm harness:statebench:build-learnings -- \
  --state-bench-dir /tmp/sherpa-state-bench \
  --output artifacts/state-bench/sherpa-learnings.json \
  --root artifacts/state-bench/sherpa-store \
  --reset
```

```bash
cd /tmp/sherpa-state-bench
SHERPA_STATE_BENCH_LEARNINGS=<repo>/artifacts/state-bench/sherpa-learnings.json \
uv run python - <<'PY'
from agents.sherpa_memory_agent import SherpaMemoryAgent
class Ctx:
    domain = 'customer_support'
    task_summary = 'customer wants a defective electronics return and refund'
agent = SherpaMemoryAgent.__new__(SherpaMemoryAgent)
agent.runtime_context = Ctx()
print(agent.retrieve_learnings('defective tablet return refund original payment shipping label', top_k=2))
PY
```

```bash
STATE_BENCH_DIR=/tmp/sherpa-state-bench \
SHERPA_STATE_BENCH_LEARNINGS=<repo>/artifacts/state-bench/sherpa-learnings.json \
pnpm harness:statebench:local-confidence -- \
  --domains customer_support \
  --tasks 55-challenge_price_match_refund \
  --variant both \
  --output-dir artifacts/state-bench/local-confidence-smoke-clean
```

## Bridge Results

| Run | Domains | Learnings | Sherpa events | Graph states |
|---|---:|---:|---:|---:|
| smoke, 2 trajectories/domain | 3 | 6 | 47 | 274 |
| full public train set | 3 | 333 | 2,420 | 6,294 |

The full artifact contains 300 trajectory cards plus 33 aggregate playbook and repeated-sequence recipe cards. The adapter retrieval smoke returned customer-support procedural learnings for defective-item return/refund queries, including tool order and resolution guidance. Retrieval scoring uses the model-provided query and benchmark domain only; it intentionally avoids `state_requirements`, `task_requirements`, and `task_summary` metadata.

## Local Confidence Result

The free local confidence runner bypasses the locked STATE-Bench simulator and judges. It uses OpenClaw-auth-backed `openai-codex/gpt-5.5`, executes public task tools in the harness, and checks deterministic `state_requirements`.

Initial single-task smoke result on `customer_support/55-challenge_price_match_refund`:

| Variant | Status | State pass | Turns | Tool calls | Tool errors | Redundant calls | Memory calls |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline `OpenClawJsonAgent` | OK | 1/1 | 1 | 6 | 0 | 1 | 0 |
| Sherpa `SherpaOpenClawMemoryAgent` | OK | 1/1 | 1 | 5 | 0 | 0 | 1 |

This is a confidence signal only. It does not run the locked user simulator, task-requirements judge, UX judge, `pass^5`, or official metrics.

### Iteration Findings

Local confidence work exposed three concrete issues and fixes:

- The scripted local user was too weak for multi-turn tasks. It now follows common public task-rule confirmations and reads profile preferences from the task environment.
- Retrieved procedural learnings could leak stale IDs from prior trajectories. The adapters now redact prior `user_*`, booking/order/item/product IDs, and flight IDs before returning memories.
- OpenClaw gateway failures could contaminate results. `OpenClawCodexClient` now retries transient gateway errors.

Current breadth-2 result across `travel`, `customer_support`, and `shopping_assistant`:

| Variant | Runs | OK | State pass | Avg turns | Avg tool calls | Avg tool errors | Avg memory calls |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 6 | 5 | 5/5 | 2.0 | 6.2 | 0.6 | 0.0 |
| Sherpa | 6 | 6 | 6/6 | 2.0 | 7.5 | 0.17 | 1.0 |

The baseline non-OK run was an OpenClaw gateway failure, not a task-state failure; rerunning `travel/1-cancel_economy_domestic` after client retries passed with 7 tool calls and 0 errors. Treating that retry as the comparable task outcome, the current local evidence is:

- both baseline and Sherpa can pass the small breadth-2 slice
- Sherpa has lower observed tool-error rate on that slice
- Sherpa still has higher average tool calls because memory retrieval and conservative grounding add overhead
- this is not yet SOTA-plausible evidence; it is a local sanity gate showing the method no longer obviously regresses on the sampled tasks

## Dockerized OpenClaw Evidence

The current research evidence should use the Dockerized OpenClaw path, not the host OpenClaw executable. The Docker wrapper builds `sherpa-openclaw-harness:local` from `ghcr.io/openclaw/openclaw:2026.5.19`, mounts the host OpenClaw auth store read-only, copies auth into the container, and invokes `openclaw` inside the container via `SHERPA_OPENCLAW_CMD_PREFIX`.

Host-backed local confidence artifacts from earlier iteration are debugging evidence only.

Current Dockerized local-confidence artifacts:

| Run | Slice | Baseline state pass | Sherpa state pass | Paired outcome | Tool delta | Error delta |
|---|---|---:|---:|---|---:|---:|
| `artifacts/state-bench/docker-smoke-v1` | `customer_support/55` Sherpa smoke | n/a | 1/1 | smoke pass | n/a | n/a |
| `artifacts/state-bench/docker-hard-support-v4` | customer-support hard `55,108,142` | 3/3 | 3/3 | 3 ties | -1 | 0 |
| `artifacts/state-bench/docker-hard-travel-v3` | travel hard `52,76,101` | 0/3 | 3/3 | 3 Sherpa wins | +2 | -2 |

Combined across those two paired hard slices:

- Baseline: 3/6 state pass.
- Sherpa: 6/6 state pass.
- Paired outcomes: 3 Sherpa wins, 0 baseline wins, 3 ties.
- Runs with infrastructure errors: 0.

The hard-travel wins came from bounded procedural repairs over current tool results: insured cancel-plus-rebook with points-plus-cash, delayed-flight compensation before cancel/rebook, and mixed two-booking budget strategy. This is applied adapter behavior that uses Sherpa's procedural-memory thesis, but these particular wins did not require a `retrieve_learnings` call in the final hard-travel aggregate. Treat this as strong local-confidence evidence, not an official SOTA result.

## OpenClaw Auth Path

The official-run wrapper now defaults to `STATE_BENCH_AGENT_BACKEND=openclaw`. In that mode, STATE-Bench uses:

- `OpenClawCodexClient` for evaluated-agent model calls
- `openclaw infer model run --gateway --model openai-codex/gpt-5.5`
- the local OpenClaw auth profile store, including `openai-codex` OAuth

Local and Docker verification confirmed:

- OpenClaw model resolves to `openai-codex/gpt-5.5`
- OpenClaw gateway auth for `openai-codex` is available in the local profile store
- the Docker smoke run completed through containerized OpenClaw with host auth copied into the container
- STATE-Bench extension loading found `OpenClawJsonAgent`, `SherpaOpenClawMemoryAgent`, and `OpenClawCodexClient`

## SOTA Eligibility Gate

No SOTA result has been claimed yet. The evaluated agent can now use local OpenClaw `openai-codex` auth, but STATE-Bench still requires locked evaluator/simulator credentials for official scoring. The next required step is an official STATE-Bench test run:

1. Run the no-memory `OpenClawJsonAgent` baseline under the locked protocol.
2. Run `SherpaOpenClawMemoryAgent` with the generated learning artifact.
3. Compute metrics for `travel`, `customer_support`, and `shopping_assistant`.
4. Compare task completion, `pass^5`, UX, and cost.
5. Claim SOTA only if Sherpa beats public/competitive memory baselines on at least one primary metric without unacceptable regression on the others.

## External Anchors

- [STATE-Bench blog](https://opensource.microsoft.com/blog/2026/05/19/introducing-state-bench-a-benchmark-for-ai-agent-memory/)
- [STATE-Bench repository](https://github.com/microsoft/STATE-Bench)
- [Agent Workflow Memory](https://proceedings.mlr.press/v267/wang25bx.html)
- [Memp: Exploring Agent Procedural Memory](https://arxiv.org/abs/2508.06433)
- [EvoMemBench](https://arxiv.org/abs/2605.18421)
