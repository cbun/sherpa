# Sherpa Trace Annotation Guide

## Purpose

This guide defines the minimum annotation standard for evidence-grade Sherpa workflow-memory evaluation.

The goal is to make each trace useful for testing whether procedural memory changes agent behavior. Annotators should label what the agent could have known at each step, which continuations were good or risky, and when Sherpa should have stayed silent.

## Splits

Use three fixed splits:

- `train`: used for ontology, projection prompt, feature, and threshold iteration
- `dev`: used for model selection, strategy comparison, and threshold tuning
- `test`: frozen until final reporting

Do not tune projection prompts, state identity, retrieval ranking, or advisory thresholds on the test split.

## Required Case Fields

Every case must include:

- `caseId`: stable case identifier
- `sourceTrace`: original trace or run identifier, anonymized if needed
- `labels`: workflow and domain labels, for example `workflow:code-fix`
- `annotations.workflowClass`: one high-level workflow class
- `annotations.taskBoundaries`: at least one task boundary
- `annotations.expectations.terminalOutcome`: `success`, `failure`, or `unknown`
- `events`: ordered Sherpa event inputs

## Recommended Event Sources

Prefer operational event types that reflect what happened, not what the annotator wishes happened.

Examples:

- `openclaw.dispatch`
- `openclaw.task`
- `tool.exec`
- `tool.read`
- `tool.edit`
- `tool.browser`
- `tool.web`
- `tool.memory`
- `tool.approval`

Use `outcome` on events whenever the local result is known.

## Step Numbering

Step numbers are 1-based positions in the authored event sequence after timestamp sorting.

For an expectation at `step: 3`, the question is:

> After event 3 has happened, what should Sherpa expect or warn about before event 4?

## Next-Step Expectations

Use `expectedNext` for acceptable next event types.

Guidelines:

- Include all acceptable continuations if more than one would be correct.
- Avoid overfitting to exact tool names if the real procedural choice is broader.
- Do not label trivial continuations unless they matter for workflow quality.

Example:

```json
{
  "step": 3,
  "expectedNext": ["tests.run", "repo.inspected"],
  "note": "Either rerunning the failing test or inspecting the local test file is acceptable."
}
```

## Risk Expectations

Use `expectedRisks` for branches Sherpa should warn against at that step.

Examples:

- patching before inspecting the failing test
- redeploying before checking environment drift
- continuing browser automation after authentication failure
- editing docs without checking approval requirements
- retrying a flaky command without changing conditions

Example:

```json
{
  "step": 4,
  "expectedRisks": ["patch.applied", "redeploy.triggered"],
  "note": "Successful cases verify config before code or deploy changes."
}
```

## Blockers

Use `annotations.blockers` for conditions that caused or could cause failure/stall.

Fields:

- `step`: 1-based step where the blocker became visible
- `type`: bounded blocker type where possible
- `detail`: short human-readable explanation
- `resolved`: whether the trace resolved it

Blocker labels should describe the operational cause, not the symptom.

## Silence Labels

If Sherpa should stay quiet at an otherwise tempting step, add a next-step expectation with an empty `expectedNext` and note why.

Example:

```json
{
  "step": 2,
  "expectedNext": [],
  "expectedRisks": [],
  "note": "No prior support should be enough to advise here; silence is preferred."
}
```

## Anonymization Rules

Before adding traces:

- replace customer, user, repo, branch, and hostname identifiers
- remove secrets, tokens, private URLs, and raw credentials
- preserve operational shape: tool category, outcome, timing, failure mode, and dependency ordering
- keep enough metadata to reconstruct why a branch was good or risky

Do not replace meaningful workflow structure with generic placeholders. For example, `payment-webhook-secret` is better than `secret-1` if the workflow class depends on webhook recovery.

## Quality Checklist

A trace is ready for evaluation when:

- timestamps or authored order are stable
- task boundaries are explicit
- terminal outcome is labeled
- at least one non-trivial expectation or risk is labeled when applicable
- raw events are sufficient evidence for the labels
- no private data remains
- the case belongs to exactly one split

## Evidence Standard

Annotators should be able to answer:

- What did the agent know at this point?
- What action would a competent agent take next?
- What branch would likely waste time or fail?
- What prior trace evidence would justify Sherpa speaking?
- Would bad advice here be harmful or merely noisy?

If those answers are unclear, mark the case as `unknown` outcome or leave it out of the held-out test set.
