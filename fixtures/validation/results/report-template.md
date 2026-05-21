# Sherpa Research Report Template

## Run Metadata

- Date:
- Git SHA:
- Command:
- Dataset:
- Split:
- Cases:
- Events:
- Ontology version:
- Projection prompt version:
- Model/projector:
- Strategy or baseline:

## Headline Result

Write one falsifiable sentence:

> Example: On the dev split, family-procedure matched raw top-k accuracy while improving annotated risk recall by X points at Y advisory precision.

## Metrics

| Metric | Value | Notes |
|---|---:|---|
| top-1 next-action accuracy |  |  |
| top-k next-action recall |  |  |
| matched steps |  |  |
| unmatched steps |  |  |
| average total support |  |  |
| average top-candidate support |  |  |
| average graph states |  |  |
| risk precision |  |  |
| risk recall |  |  |
| advisory precision |  |  |
| silence precision |  |  |
| task success rate |  |  |
| harm rate |  |  |

## Baseline Comparison

| Baseline | top-1 | top-k | risk precision | risk recall | support density | notes |
|---|---:|---:|---:|---:|---:|---|
| raw suffix |  |  |  |  |  |  |
| procedure |  |  |  |  |  |  |
| family-procedure |  |  |  |  |  |  |
| semantic RAG |  |  |  |  |  |  |
| textual lessons |  |  |  |  |  |  |
| long-context GPT-5.5 |  |  |  |  |  |  |

## Accepted And Rejected Claims

| Claim | Decision | Evidence | Next action |
|---|---|---|---|
| H1 raw procedural recurrence exists | pending |  |  |
| H2 semantic abstraction improves generalization | pending |  |  |
| H3 graph memory beats textual memory under budget | pending |  |  |
| H4 sparse advice improves behavior | pending |  |  |
| H5 procedural memory transfers | pending |  |  |

## Failure Analysis

List the most important misses and false positives.

| Case | Step | Expected | Predicted | Interpretation |
|---|---:|---|---|---|
|  |  |  |  |  |

## Decision

Choose one:

- keep current thesis
- narrow current thesis
- replace state identity
- shift to risk/intervention objective
- keep shadow-only
- collect more evidence before deciding

## Follow-Up Work

1.
2.
3.
