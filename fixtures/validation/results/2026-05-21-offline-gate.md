# Sherpa Offline Gate Report

## Run Metadata

- Date: 2026-05-21
- Git SHA: `e29c65a` plus the research-harness changes committed in this series
- Synthetic validation artifact: `fixtures/validation/results/2026-05-21-validate-synthetic.json`
- Suite validation artifact: `fixtures/validation/results/2026-05-21-validate-suite.json`
- Baseline artifact: `fixtures/validation/results/2026-05-21-baselines-synthetic.json`
- Research gate artifact: `fixtures/validation/results/2026-05-21-research-gate-openclaw-realish.json`

## Commands

```bash
node packages/cli/dist/index.js validate \
  --dataset fixtures/validation/synthetic-workflows.json \
  --top-k 3
```

```bash
node packages/cli/dist/index.js validate-suite \
  --input fixtures/validation/suite.json \
  --max-failing-datasets 10
```

```bash
node packages/cli/dist/index.js validate-baselines \
  --dataset fixtures/validation/synthetic-workflows.json \
  --top-k 3
```

```bash
node packages/cli/dist/index.js research-gate \
  --dataset fixtures/validation/openclaw-realish.json \
  --top-k 3
```

## Offline Summary

| Run | Cases | Events | Evaluated steps | Top-1 | Top-k | Misses |
|---|---:|---:|---:|---:|---:|---:|
| synthetic Sherpa validation | 6 | 30 | 24 | 0.833 | 0.917 | 2 |
| bundled validation suite | 10 | 40 | 30 | 0.667 | 0.733 | 8 |

Synthetic Sherpa validation also reported average graph states of `33.25`, average total support of `3.333`, and one unmatched prediction step.

## Baseline Summary

Default `validate-baselines` now includes:

- `global-majority`
- `raw-ngram`
- `workflow-class-ngram`
- `semantic-rag-lite`
- `textual-lesson-prior`

On `synthetic-workflows.json`, the best baseline was `raw-ngram` with top-1 `0.708`, top-k `0.958`, and `1` miss.

## Claim Decisions

| Claim | Decision | Evidence | Iteration consequence |
|---|---|---|---|
| H1 raw procedural recurrence exists | supported | raw top-k `0.200` vs global-majority top-k `0.150` on `openclaw-realish.json` | keep raw suffix recurrence as a mandatory baseline |
| H2 semantic procedural abstraction preserves generalization | supported | raw top-1/top-k `0.200/0.200`; family-procedure top-1/top-k `0.200/0.200` | abstraction is not yet better, but it is not worse under this fixture |
| H3 graph memory beats non-Sherpa sequence baselines | rejected | best Sherpa top-k `0.200`; best baseline `raw-ngram` top-k `0.350` | do not claim graph superiority; pivot to stronger retrieval, advice-value, or narrower thesis |
| H4 sparse advice improves behavior without harm | pending | offline annotated risk recall `0.000`; sandbox intervention evidence still required | scale paired sandbox suites before claiming applied impact |
| H5 transfer across repos/families/agents/frameworks | pending | cross-domain held-out splits are not yet evaluated | populate fixed held-out splits before transfer claims |

## Interpretation

The current implementation is useful as a reproducible research harness and as a procedural-memory prototype, but the central graph-superiority claim is not supported by the current offline gate. The next scientific move is not to assume Sherpa works; it is to iterate on the retrieval thesis or reframe the contribution around local-first trace capture plus intervention value if stronger baselines continue to win.
