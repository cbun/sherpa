# Sherpa 10/10 Research Plan

## Purpose

This plan defines the path from the current Sherpa prototype to a 10/10 scientific contribution.

The target is not to prove that the current implementation works. The target is to create a research program that can discover, falsify, or refine the right procedural-memory thesis for tool-using LLM agents.

The strongest possible contribution is:

> A general theory, benchmark, and reproducible system for procedural memory in LLM agents, showing when structured experience improves agent behavior over raw traces, semantic memory, long context, and reflective memory.

If the current suffix-graph approach fails, the program should still produce a useful result: a better abstraction, a narrower claim, or a rigorous negative result about when procedural memory should stay silent.

## Current Evidence And Claim Discipline

Sherpa currently has a credible system shape:

- canonical append-only ledger
- rebuildable derived graph
- bounded semantic projection
- raw, procedure, and family-procedure retrieval strategies
- CLI validation and simulation surfaces
- isolated OpenClaw Docker harness
- OpenClaw plugin, SDK, and MCP surfaces

The current evidence does not yet justify a strong scientific claim.

Known constraints from the repo state:

- The v1 task list says validation still depends too much on synthetic or starter realistic traces.
- The documented five-session replay sample has raw suffix matching slightly ahead of family-procedure matching.
- The hard unresolved problem is calibration: which semantic distinctions should define state identity, which should be used only for reranking or explanation, and when Sherpa should abstain.

Therefore every research phase below is framed around falsification gates. A result only counts if it survives strong baselines and held-out evaluation.

## Literature Grounding

Sherpa sits at the intersection of four research areas.

### LLM Agent Memory

Recent memory surveys argue that LLM agents need memory beyond a single context window and evaluate memory as an interaction between write, manage, and read policies. They also emphasize that static recall benchmarks are insufficient for multi-session agent decision making.

Relevant work:

- [Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers](https://arxiv.org/abs/2603.07670)
- [A Survey on the Memory Mechanism of Large Language Model based Agents](https://arxiv.org/abs/2404.13501)
- [Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions](https://arxiv.org/abs/2507.05257)
- [EvoMemBench: Benchmarking Agent Memory from a Self-Evolving Perspective](https://arxiv.org/abs/2605.18421)

Research implication for Sherpa:

- Evaluate memory as behavior change under interaction, not only as retrieval accuracy.
- Include long-context and RAG baselines because memory systems do not always beat them.
- Separate knowledge-oriented memory from execution-oriented memory.

### Experience Reuse In Agents

Prior work shows agents can benefit from prior trajectories, lessons, or skills without parameter updates.

Relevant work:

- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
- [ExpeL: LLM Agents Are Experiential Learners](https://arxiv.org/abs/2308.10144)
- [Voyager: An Open-Ended Embodied Agent with Large Language Models](https://arxiv.org/abs/2305.16291)
- [Agent KB: Leveraging Cross-Domain Experience for Agentic Problem Solving](https://arxiv.org/abs/2507.06229)

Research implication for Sherpa:

- Compare against textual reflection and trajectory-retrieval baselines, not only raw event graphs.
- Include a disagreement gate so retrieved memory can be suppressed when it conflicts with current reasoning.
- Measure whether memory changes action choice and outcome, not just whether it retrieves a similar past case.

### Procedural And Experience Graph Memory

Recent work is moving directly into procedural memory and graph-structured experience.

Relevant work:

- [Agent Workflow Memory](https://arxiv.org/abs/2409.07429)
- [LEGOMem: Modular Procedural Memory for Multi-agent LLM Systems for Workflow Automation](https://arxiv.org/abs/2510.04851)
- [EXG: Self-Evolving Agents with Experience Graphs](https://arxiv.org/abs/2605.17721)
- [EvoMemBench](https://arxiv.org/abs/2605.18421)

Research implication for Sherpa:

- Sherpa cannot claim novelty merely from "procedural memory" or "experience graph".
- The sharper claim must be about local-first, inspectable, low-latency procedural memory for software/tool-using agents, with calibrated abstention and replayable evidence.

### Predictive And Prescriptive Process Monitoring

Process mining already studies next-event prediction, outcome prediction, remaining time, risk, interpretability, and next-best-action recommendation over event logs.

Relevant work:

- [Predictive process monitoring: concepts, challenges, and future research directions](https://link.springer.com/article/10.1007/s44311-024-00002-4)
- [Predictive business process monitoring with AutoML for next activity prediction](https://journals.sagepub.com/doi/10.3233/IDT-240632)
- [ProcessTransformer: Predictive Business Process Monitoring with Transformer Network](https://arxiv.org/abs/2104.00721)
- [Trace Encoding in Process Mining: a survey and benchmarking](https://arxiv.org/abs/2301.02167)
- [Prescriptive Business Process Monitoring for Recommending Next Best Actions](https://arxiv.org/abs/2008.08693)
- [OCEL 2.0 Specification](https://arxiv.org/abs/2403.01975)
- [PM4Py: A process mining library for Python](https://www.sciencedirect.com/science/article/pii/S2665963823000933)

Research implication for Sherpa:

- Treat next-step prediction as only one task.
- Evaluate risk, outcome, intervention value, explanation, and cost.
- Compare against at least one process-mining-inspired sequence model or trace-encoding baseline.
- Make interpretability intrinsic, not only a post-hoc explanation.

### Computer-Use Agent Benchmarks

Computer-use benchmarks make clear that real interactive environments are still hard, non-saturated evaluation settings. Since this plan was first written, Microsoft released STATE-Bench as a current public benchmark for evaluating whether agent memory improves realistic stateful tasks. It is now the primary SOTA-facing applied target for Sherpa because it tests task completion, reliability, UX, and cost rather than only offline next-step prediction.

Relevant work:

- [OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments](https://papers.nips.cc/paper_files/paper/2024/hash/5d413e48f84dc61244b6be550f1cd8f5-Abstract-Datasets_and_Benchmarks_Track.html)
- [STATE-Bench blog](https://opensource.microsoft.com/blog/2026/05/19/introducing-state-bench-a-benchmark-for-ai-agent-memory/)
- [STATE-Bench repository](https://github.com/microsoft/STATE-Bench)

Research implication for Sherpa:

- Offline replay is not enough for a strong claim.
- The Docker/OpenClaw harness should become a small, local analogue of OSWorld-style execution evaluation for OpenClaw workflows.
- Report both outcome and efficiency metrics, not only prediction metrics.

## First-Principles Problem Statement

An LLM-agent workflow is a partially observed trajectory:

```text
state_t = hidden task state, repo state, user intent, tool environment, constraints
obs_t = messages, tool calls, tool outputs, browser state, files read, errors
act_t = next message, tool call, edit, search, pause, ask, complete
outcome = success, failure, stall, cost, user correction, latent quality
```

The memory problem is not "find similar text." It is:

> Given a partial trajectory and a budget for memory injection, identify whether prior experience should change the next action, risk estimate, or verification plan.

This yields five design principles:

- Memory must optimize expected utility, not similarity.
- Advice has a cost; silence can be correct.
- Raw episodes are evidence and must remain recoverable.
- Consolidated abstractions are hypotheses and must be versioned.
- User-facing claims must be traceable to support, outcomes, uncertainty, and freshness.

## Hypothesis Tree

The research should evaluate these hypotheses in order.

### H1: Raw Procedural Recurrence Exists

Claim:

> Recent raw event suffixes predict useful next actions, risks, or outcomes above chance and above prompt-only heuristics.

If H1 fails:

- Move away from next-step prediction.
- Focus on audit, trace summarization, and post-hoc workflow analytics.
- Treat procedural memory as observability, not advisory control.

### H2: Semantic Procedural Abstraction Improves Generalization

Claim:

> Bounded semantic procedure/family abstractions improve held-out behavior over raw event suffixes by increasing recurrence across superficially different traces.

If H2 fails but H1 works:

- Keep raw suffix matching as primary retrieval.
- Use semantic projection for explanation, filtering, and reranking only.
- Reframe the contribution as inspectable raw procedural memory with semantic annotations.

### H3: Structured Graph Memory Beats Textual Memory Under Injection Budgets

Claim:

> A derived workflow graph gives better calibrated, lower-cost advice than semantic RAG, Reflexion-style text lessons, and trajectory examples when context budget is limited.

If H3 fails:

- Use Sherpa as a retrieval router and evidence ledger.
- Generate textual lessons from the ledger, but keep the raw ledger as canonical evidence.
- Research the hybrid: graph selects evidence, LLM writes bounded advice.

### H4: Sparse Advice Improves Agent Behavior

Claim:

> Injecting Sherpa advice only above calibrated support/confidence thresholds improves task outcomes or reduces bad branches without increasing harm.

If H4 fails:

- Keep Sherpa in shadow mode.
- Surface advice through explicit tools instead of automatic injection.
- Optimize for debug, replay, and operator dashboards rather than runtime steering.

### H5: Procedural Memory Transfers

Claim:

> Learned procedural structures transfer across repos, task families, agents, or frameworks when represented at the right abstraction level.

If H5 fails:

- Scope Sherpa to per-agent and per-repo local memory.
- Treat transfer as future work.
- Avoid broad cross-domain claims.

## Research Questions

The final work should answer these questions explicitly:

1. What is the right unit of procedural memory for software agents: raw event, operation, family+procedure, episode, lesson, graph motif, or executable skill?
2. When does semantic abstraction help prediction, and when does it over-partition or over-merge?
3. Can procedural memory improve risk detection even when it does not improve next-step accuracy?
4. How often should an agent memory system abstain?
5. Does advice help in live sandbox runs, or only in offline replay?
6. What provenance is necessary for users to trust a procedural recommendation?
7. Which task classes are procedural enough to benefit: code repair, setup, incident response, docs, research, approvals, browser flows?
8. What is the smallest memory representation that preserves useful behavior?

## Evaluation Design

Evaluation has to cover offline replay and online sandbox behavior. Offline replay tells us whether the memory model has signal. Online sandbox runs tell us whether injection changes agent behavior.

### Offline Corpus

Target artifact:

- `fixtures/validation/openclaw-real-train.json`
- `fixtures/validation/openclaw-real-dev.json`
- `fixtures/validation/openclaw-real-test.json`
- `fixtures/validation/annotation-guide.md`
- `fixtures/validation/results/`

Minimum credible v1:

- 100 to 300 real or realistic OpenClaw traces
- 2,000 to 10,000 typed events
- explicit train/dev/test split
- task families: code repair, setup, docs, research/browser, incident/debugging, approvals, automation
- at least 20 traces per major family where possible

Annotations:

- task boundary
- current task family
- expected next action set
- unacceptable next action set
- blocker type
- risky branch
- terminal outcome
- useful intervention point
- whether advice should be silent
- whether raw trace contains enough context to judge the case

Dataset rules:

- Tune only on train/dev.
- Freeze test.
- Version every projection schema and rerun historical projections intentionally.
- Keep raw ledger events as evidence.
- Document anonymization and exclusion criteria.

### Online Sandboxed OpenClaw Suite

Use the Docker harness, not the personal OpenClaw install.

Host auth and GPT-5.5 path:

```bash
OPENCLAW_COPY_HOST_AUTH=1 \
OPENCLAW_MODEL_PRIMARY=openai-codex/gpt-5.5 \
OPENCLAW_AGENT_MODE=gateway \
bash harness/openclaw/smoke.sh
```

Harness upgrades:

- Make the read-only host auth mount configurable without editing compose files by hand.
- Add a task-suite runner that executes scripted OpenClaw tasks from JSON/YAML.
- Create a fresh Docker volume per run.
- Export OpenClaw sessions, Sherpa ledger, graph store, projection cache, advisory log, and final task artifacts.
- Support `shadow`, `tool-only`, and `advisory-injected` modes.
- Add deterministic run IDs and result directories.
- Record model, OpenClaw version, Sherpa git SHA, ontology version, projection prompt version, and harness config.

Online task suite:

- 30 to 50 executable tasks for initial evidence
- 100+ executable tasks for a serious 10/10 claim
- intentionally repeated task motifs with varied surface details
- seeded failure branches, flaky environment checks, stale docs, missing credentials, browser/search ambiguity, approval gates

Online run modes:

- `none`: no Sherpa memory
- `shadow`: Sherpa captures and predicts but does not inject advice
- `tool-only`: agent may call Sherpa tools explicitly
- `advisory`: Sherpa injects advice above threshold
- `oracle-upper-bound`: curated expert advice injected at the same intervention points

## Baselines

A strong paper or research artifact needs baselines that can beat Sherpa.

### Local Sequence Baselines

- raw event suffix graph
- fixed-order n-gram
- variable-order Markov model / probabilistic suffix tree
- procedure-only graph
- family+procedure graph
- family+procedure with context reranking
- graph with support-density state merging

### Semantic And Textual Baselines

- semantic RAG over raw event summaries
- semantic RAG over full session summaries
- Reflexion-style lessons
- ExpeL-style experience plus extracted insight memory
- Agent KB-style trajectory retrieval with disagreement gate
- long-context GPT-5.5 prompt-only baseline

### Learned Process Baselines

- ProcessTransformer-style next-activity model when corpus size is sufficient
- trace-encoding plus classifier/regressor for next action, risk, and outcome
- simple logistic or gradient-boosted models over event-window features

### Operational Baselines

- no-memory OpenClaw
- OpenClaw with only conversation/context memory
- OpenClaw with only semantic document memory
- human-authored checklist injection for selected workflows

## Metrics

Use metrics that match the thesis. Next-step accuracy alone is insufficient.

### Prediction Metrics

- top-1 next-action accuracy
- top-k next-action recall
- mean reciprocal rank
- expected calibration error for branch probabilities
- support density per matched state
- state count and state growth
- backoff depth distribution

### Risk And Outcome Metrics

- risk precision
- risk recall
- risk lead time
- false-alarm rate
- terminal outcome prediction
- stall prediction
- bad-branch avoidance

### Advisory Metrics

- advisory precision
- advisory recall at annotated intervention points
- silence precision: did Sherpa stay quiet when it should?
- harm rate: advice caused or encouraged worse behavior
- advice count per task
- accepted/ignored advice where observable
- disagreement-gate suppressions

### Agent Behavior Metrics

- task success rate
- tool calls to completion
- wall-clock time
- repeated failed tool loops
- number of user corrections
- number of unnecessary semantic/context lookups
- cost and latency

### Interpretability Metrics

- every recommendation has support count, matched state, candidate probability, outcome stats, freshness, and evidence IDs
- explanation faithfulness: explanation fields correspond to actual graph/retrieval evidence
- operator judgment score on a held-out explanation sample

## Iteration Paths If The Current Thesis Fails

This section is the core of the plan. Each failure mode has a planned pivot.

### Failure Mode: Raw Beats Semantic Abstraction

Symptoms:

- raw top-k remains higher than family+procedure
- projected states have lower support density
- semantic labels fragment repeated workflows

Actions:

- make raw the primary predictive path
- use projection only for explanations and risk labels
- learn state abstractions from data using support-density and information-gain criteria
- introduce mixture retrieval that scores raw and abstract states together
- demote artifact, entity, blocker, and tool details from state identity

Revised claim:

> Procedural memory benefits from canonical raw traces, while semantic projection is most useful for explanation and safe filtering.

### Failure Mode: Next-Step Prediction Is Weak

Symptoms:

- no strategy predicts next actions reliably
- top-k is noisy across task classes
- predictions are obvious or useless

Actions:

- shift objective to branch risk, stall prediction, and intervention value
- predict "avoid patch before env check" rather than "next event is env check"
- annotate intervention points and forbidden branches
- evaluate next-best-action by outcome improvement, not imitation accuracy

Revised claim:

> Procedural memory is more valuable as a risk and intervention layer than as an imitation-based next-action predictor.

### Failure Mode: Advice Harms Agent Behavior

Symptoms:

- advisory mode performs worse than shadow mode
- wrong advice derails tasks
- too many low-value injections

Actions:

- add an expected-utility threshold before injection
- add disagreement gates against the agent's current plan
- require higher support for automatic injection than for tool responses
- make advice ask-oriented: "verify X before Y" instead of command-oriented
- ship shadow/tool-only mode as default

Revised claim:

> Procedural memory should first be an inspectable decision-support layer; automatic injection requires separate calibration.

### Failure Mode: Projection Is Too Noisy

Symptoms:

- low confidence or unstable labels across reruns
- ontology drift
- frequent unknowns
- high disagreement between projector versions

Actions:

- separate mechanical event typing from semantic projection
- store projector confidence per field
- require field-level confidence for state identity
- reproject ledgers under explicit version control
- compare GPT-5.5 projection against smaller/cheaper classifiers
- build a projection-error audit set

Revised claim:

> The ledger/projection separation is necessary because semantic consolidation is a versioned hypothesis, not canonical history.

### Failure Mode: Workflows Are Too Idiosyncratic

Symptoms:

- low recurrence even after abstraction
- support remains too sparse
- task families do not transfer

Actions:

- narrow supported workflow classes
- discover motifs within family instead of global patterns
- preserve per-user/per-agent memory rather than global memory
- use Sherpa for "have we seen this exact trap before?" instead of broad prediction

Revised claim:

> Procedural memory is task-family dependent; the scientific result is identifying which agent workflows are learnable from local traces.

### Failure Mode: Textual Memory Beats Graph Memory

Symptoms:

- Reflexion/ExpeL-style lessons improve behavior more than graph retrieval
- graph evidence is too low-level for planning

Actions:

- use graph retrieval to select evidence
- synthesize lessons from successful and failed branches
- keep graph support as provenance for generated advice
- compare generated lessons with and without graph grounding

Revised claim:

> Structured procedural traces are best used as grounded evidence for memory synthesis, not always as the final advice representation.

## Core Algorithm Research Tracks

### Track A: State Identity

Goal:

- Find the smallest state representation that preserves useful predictive and risk signal.

Variants:

- raw event suffix
- event plus procedure
- family plus procedure
- learned state merges
- information-gain selected facets
- support-density constrained facets
- probabilistic suffix tree

Exit criteria:

- state growth is bounded
- support density improves over raw or justifies its cost through better risk/advice metrics
- matched state explanations stay faithful

### Track B: Retrieval And Ranking

Goal:

- Rank candidate continuations by expected utility, not just frequency.

Variants:

- empirical next-event probability
- success-weighted probability
- risk-adjusted expected value
- freshness decay
- uncertainty penalty
- context reranking
- disagreement gate with current agent plan

Exit criteria:

- calibrated probabilities
- fewer harmful suggestions
- better advisory precision at equal or lower injection rate

### Track C: Intervention Policy

Goal:

- Decide when to speak.

Variants:

- support threshold
- confidence threshold
- expected value threshold
- risk lead-time threshold
- silence classifier
- user-configured verbosity

Exit criteria:

- high silence precision
- low advice count per task
- advisory mode improves or safely matches shadow mode

### Track D: Memory Consolidation

Goal:

- Convert raw episodes into reusable procedural knowledge without corrupting evidence.

Variants:

- no consolidation
- graph-only consolidation
- textual lesson synthesis
- graph-grounded textual lessons
- failure templates
- checklist synthesis

Exit criteria:

- consolidated memories can be traced back to raw episodes
- consolidation improves behavior on held-out tasks
- stale or contradictory memories can be detected and retired

## Implementation Roadmap

### R0: Research Protocol

Deliverables:

- this plan
- annotation guide
- benchmark schema update if needed
- result report template
- fixed train/dev/test policy

Completion gate:

- a new evaluator can label a trace consistently using only the guide.

### R1: Offline Benchmark

Deliverables:

- 100+ annotated traces
- strategy comparison command
- support-density and state-growth report
- risk/advisory metric report
- projection drift report

Completion gate:

- raw, procedure, family-procedure, semantic RAG, textual lesson, and long-context baselines all run on the same split.

### R2: Docker OpenClaw Research Harness

Deliverables:

- host-auth read-only mount option
- GPT-5.5 gateway mode as a documented preset
- task-suite runner
- isolated volume per run
- result export bundle
- mode switch: none, shadow, tool-only, advisory

Completion gate:

- the full suite can run without writing to the host OpenClaw install.

### R3: Baseline Implementations

Deliverables:

- variable-order raw suffix baseline
- semantic RAG baseline
- textual lesson baseline
- long-context GPT-5.5 baseline
- learned process baseline when corpus size permits

Completion gate:

- each baseline has one command, one result JSON, and one row in the report.

### R4: Thesis Iteration

Deliverables:

- state identity ablations
- reranking ablations
- advice abstention ablations
- failure-mode report
- accepted/rejected claims table

Completion gate:

- the current Sherpa thesis is either supported, narrowed, or replaced by a stronger claim.

### R5: Sandboxed Intervention Study

Deliverables:

- task suite with repeated motifs
- shadow vs advisory comparison
- no-memory baseline
- oracle-advice upper bound
- qualitative failure analysis

Completion gate:

- advisory behavior is evaluated against real agent outcomes, not just replay labels.

### R6: Scientific Artifact

Deliverables:

- paper-style writeup
- benchmark release or private reproducibility bundle
- method documentation
- ablation report
- result dashboard or generated markdown report
- negative-results section

Completion gate:

- a reader can reproduce headline tables from a clean checkout and documented credentials.

## What Counts As 8/10

An 8/10 result is credible if:

- a real held-out corpus exists
- Sherpa is competitive with raw next-step prediction
- Sherpa clearly improves at least one of risk detection, advisory precision, explanation, compression, or low-cost operation
- Docker sandbox intervention runs show no meaningful harm
- the product artifact is usable by someone other than the author

Example acceptable headline:

> On 100 held-out OpenClaw workflows, Sherpa matched raw next-action top-k accuracy while improving risky-branch precision by 25 points and producing inspectable advisories with fewer than one injection per task.

## What Counts As 10/10

A 10/10 result requires more than "Sherpa worked for us."

Required scientific package:

- formal definition of procedural memory for tool-using LLM agents
- benchmark with task families, annotations, and sandbox execution
- comparison against raw traces, semantic RAG, textual reflection, trajectory retrieval, long context, and process-mining baselines
- clear result showing when structured procedural memory wins, ties, or loses
- calibrated abstention and harm analysis
- interpretability/provenance guarantees
- negative-results section
- reproducible code and result generation

Example 10/10 headline:

> Procedural memory improves execution-oriented LLM-agent tasks only under identifiable recurrence and context-budget conditions; a local graph-grounded memory with calibrated abstention reduces repeated failure branches and memory-injection cost while preserving inspectable provenance.

This would be strong because it is not merely a system demo. It would define a problem, provide a benchmark, test competing memory forms, and explain the boundary conditions under which procedural memory is actually useful.

## Final Writeup Outline

1. Introduction: why agent memory needs execution-oriented procedural memory.
2. Related work: agent memory, experience reuse, experience graphs, process mining.
3. Problem formulation: memory as utility-improving intervention under budget.
4. System: ledger, projection, graph, retrieval, advice, provenance.
5. Benchmark: offline corpus and Docker OpenClaw sandbox.
6. Methods: raw suffix, procedural abstraction, reranking, abstention, baselines.
7. Offline results: prediction, risk, support density, calibration, explanation.
8. Online results: shadow vs advisory, outcome, harm, cost.
9. Failure analysis: where procedural memory loses.
10. Discussion: boundary conditions, privacy, local-first design, future work.

## Immediate Next Actions

1. Add the annotation guide and train/dev/test fixture layout.
2. Add support-density, state-count, and advisory metrics to validation reports.
3. Extend the Docker harness into a task-suite runner with isolated run bundles.
4. Implement semantic RAG and textual lesson baselines.
5. Run a 30-case pilot and use the failure-mode table above to decide whether to keep, narrow, or replace the current family+procedure thesis.

## Execution Status

Completed foundation:

- annotation guide exists at `fixtures/validation/annotation-guide.md`
- seed split files exist at `fixtures/validation/openclaw-real-{train,dev,test}.json`
- validation reports include support, match-mode, graph-state, and annotated risk metrics
- `validate-baselines` compares global-majority, raw n-gram, workflow-class n-gram, semantic-rag-lite, and textual-lesson-prior baselines
- `research-gate` emits H1-H5 thesis decisions from Sherpa and baseline comparisons
- Docker harness has a task-suite runner with mode selection and exported run artifacts
- STATE-Bench bridge exists at `harness/state-bench`
- host-authenticated GPT-5.5 gateway runs are documented through `OPENCLAW_COPY_HOST_AUTH=1`, `OPENCLAW_MODEL_PRIMARY=openai-codex/gpt-5.5`, and `OPENCLAW_AGENT_MODE=gateway`
- Sherpa is loaded as a startup OpenClaw runtime plugin inside the Docker harness
- sandbox smoke results are recorded at `fixtures/validation/results/2026-05-21-sandbox-smoke.md`
- offline generated reports are recorded at `fixtures/validation/results/2026-05-21-validate-synthetic.json`, `fixtures/validation/results/2026-05-21-validate-suite.json`, `fixtures/validation/results/2026-05-21-baselines-synthetic.json`, and `fixtures/validation/results/2026-05-21-research-gate-openclaw-realish.json`
- the interpreted offline gate report is recorded at `fixtures/validation/results/2026-05-21-offline-gate.md`
- STATE-Bench bridge report is recorded at `fixtures/validation/results/2026-05-21-statebench-bridge.md`

Completed sandbox evidence:

- shadow mode: 2/2 tasks completed, 0 failures, 6 final events, 2 cases, 14 graph states
- advisory mode: 2/2 tasks completed, 0 failures, 12 final events, 2 cases, 30 graph states
- both runs used `openai-codex/gpt-5.5` through OpenClaw gateway mode with host auth mounted read-only
- the runner now waits for captured event counts to advance before saving workflow status artifacts

Completed offline gate evidence:

- synthetic Sherpa validation: top-1 `0.833`, top-k `0.917`, `2` misses across `24` evaluated steps
- bundled validation suite: top-1 `0.667`, top-k `0.733`, `8` misses across `30` evaluated steps
- synthetic baseline comparison: best baseline `raw-ngram` with top-1 `0.708`, top-k `0.958`, `1` miss
- current `openclaw-realish` gate: H1 supported, H2 supported, H3 rejected, H4 pending, H5 pending
- H3 rejection means the graph-superiority thesis is not currently supported and must be iterated before any 10/10 scientific claim

Completed STATE-Bench bridge evidence:

- public train trajectory bridge: 333 learnings across travel, customer support, and shopping, including 300 trajectory cards plus 33 aggregate playbook and repeated-sequence recipe cards
- Sherpa projection: 2,420 train events and 6,294 graph states
- Python `SherpaMemoryAgent` adapter retrieves learning cards through STATE-Bench's `retrieve_learnings(query, top_k)` interface
- OpenClaw-backed STATE-Bench client and agents use local `openai-codex` OAuth through `openclaw infer model run --gateway`
- official STATE-Bench runner exists as `pnpm harness:statebench:official`
- no public SOTA result is claimed until the locked STATE-Bench evaluator/simulator credentials are available and the test protocol is run against no-memory and competitive memory baselines

Next open work:

- populate the train/dev/test files with evidence-grade traces
- implement learned process and long-context baselines
- run the first 30-case pilot and update the accepted/rejected claims table
- run official STATE-Bench no-memory and Sherpa-memory evaluations for all three domains, then compare task completion, `pass^5`, UX, and cost
