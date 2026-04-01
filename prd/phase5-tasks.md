# Phase 5: Behavioral Model — Task List

PRD reference: `sherpa-prd.md` §Phase 5

## A. Context Capture at Ingest
**Effort: 2-3 hours**

- [ ] **A1.** Add `context` field to `SherpaEventSchema` in `types.ts`
  - `context?: { text?: string; preceding?: string; toolArgs?: string }`
  - All fields optional, truncation caps: text 500, preceding 200, toolArgs 300
- [ ] **A2.** Update `SherpaEventInput` validation to accept context field
- [ ] **A3.** Plugin capture hooks (`plugin.ts`): populate context from hook payloads
  - `before_prompt_build` → `context.text` (user message), `context.preceding` (last assistant msg)
  - `before_tool_call` → `context.toolArgs` (tool name + args summary)
  - `after_tool_call` → `context.text` (tool output snippet)
- [ ] **A4.** Respect `ledger.redactRawText` config — skip context capture when true
- [ ] **A5.** Ledger schema: `ensureColumn('events', 'context', 'TEXT')` in store.ts migration
- [ ] **A6.** Tests: context field roundtrips through ingest → ledger → read

## B. Consolidation Classifier Upgrade
**Effort: 1 day**

- [ ] **B1.** Update classifier prompt in `llm-classify.ts` to include `context.text` when available
  - Prompt should request: intent, domain, sentiment, enrichedType, confidence
  - Intent vocabulary: command, question, correction, followup, escalation, approval, abandonment, pivot
  - Domain vocabulary: config, debug, refactor, research, ops, test, communication, creative
- [ ] **B2.** Update `ClassifyResult` type to include `intent`, `domain`, `sentiment` fields
- [ ] **B3.** Update `consolidateEvents()` in `consolidate.ts` to pass context to classifier
- [ ] **B4.** Store intent/domain/sentiment in event `meta` after consolidation
- [ ] **B5.** Tests: classifier with context produces richer types than without
- [ ] **B6.** Corpus validation: re-consolidate 168-session corpus, measure vocabulary size
  - Target: 30-50 distinct enriched types (vs ~7 current)

## C. Outcome Tracking: User Response Distributions
**Effort: 1 day**

- [ ] **C1.** Modify `rebuild()` in `engine.ts`: for each state edge, compute user response distribution
  - For each transition A→B, look at what the *user* does next (the event after B where actor=user)
  - Aggregate into distribution: `{ correction: N, approval: N, pivot: N, ... }`
- [ ] **C2.** Add `response_dist` column to `state_edges` table (JSON TEXT, nullable)
- [ ] **C3.** Populate `response_dist` during `rebuild()` from enriched event types
- [ ] **C4.** Deprecate `risk_metrics` and `success_metrics` tables
  - Keep tables for backward compat but stop populating in rebuild
  - Add deprecation comments
- [ ] **C5.** Tests: response distributions computed correctly from known event sequences

## D. API Refactor: `workflowSignals()`
**Effort: 1 day**

- [ ] **D1.** Define `Signal` type in `types.ts`:
  ```typescript
  interface Signal {
    state: string[];
    prediction: string;
    probability: number;
    support: number;
    userResponseDist: Record<string, number>;
    basis: { caseId: string; context?: string }[];
  }
  ```
- [ ] **D2.** Implement `workflowSignals()` in `engine.ts`
  - Query current state, get outgoing edges with response distributions
  - For each edge with sufficient support, pull basis cases with context snippets
  - Return raw signals, no filtering or judgment
- [ ] **D3.** Deprecate `workflowRisks()` — reimplement as wrapper over `workflowSignals()`
  - Filter for signals where correction + escalation + abandonment > threshold
- [ ] **D4.** Update `workflowNext()` to include `userResponseDist` in candidates
- [ ] **D5.** Register `workflow_signals` tool in OpenClaw plugin + MCP server
- [ ] **D6.** Update SDK client with `workflowSignals()` method
- [ ] **D7.** Update CLI with `sherpa signals` command
- [ ] **D8.** Tests: signals return correct distributions and basis cases

## E. Advisory Interpreter (LLM-based)
**Effort: 1 day**

- [ ] **E1.** New module: `advisory-interpreter.ts`
  - Input: Signal[] + current conversation context (message array from hook)
  - Makes one LLM call to determine what's worth surfacing and how to frame it
  - Output: advisory string or null (suppress)
- [ ] **E2.** Prompt design for interpreter:
  - "Given these behavioral signals about the user and the current conversation, decide if anything is worth surfacing. If so, frame it naturally. If not, return null."
  - No hardcoded advisory templates
- [ ] **E3.** Wire into `before_prompt_build` hook in plugin.ts
  - Call `workflowSignals()`, if high-confidence signals exist → call interpreter
  - Replace current hardcoded advisory injection logic
- [ ] **E4.** Fallback: if no LLM available, generate template-based advisory from raw signal data
- [ ] **E5.** Remove hardcoded advisory cooldown logic
- [ ] **E6.** Remove `collectMetrics()` in current form
- [ ] **E7.** Config: `advisory.interpreterModel` for cheap model override
- [ ] **E8.** Tests: interpreter receives signals, produces/suppresses advisories

## F. Validation & Corpus Evaluation
**Effort: half day

- [ ] **F1.** Re-run 168-session corpus through full pipeline:
  1. Ingest with context capture (simulated from session logs)
  2. Consolidate with upgraded classifier
  3. Rebuild with response distributions
  4. Simulate with enriched types
- [ ] **F2.** Measure and report:
  - Vocabulary size (target: 30-50 types)
  - Prediction accuracy on intent sequences (target: >75%)
  - Signal quality: % of high-support states with meaningful response distributions
- [ ] **F3.** Generate 10 advisory examples from corpus, manual audit for usefulness
- [ ] **F4.** Before/after comparison document
- [ ] **F5.** Commit and push all changes

## Cleanup (post-validation)

- [ ] **X1.** Remove deprecated `risk_metrics` / `success_metrics` table creation from store.ts
- [ ] **X2.** Update README with Phase 5 capabilities
- [ ] **X3.** Update PRD open questions with Phase 5 learnings

---

## Dependency order

```
A (context capture) → B (classifier upgrade) → C (response distributions) → D (signals API) → E (advisory interpreter) → F (validation)
```

A and the schema parts of C can run in parallel. B depends on A. D depends on C. E depends on D. F validates everything.

## Estimated total effort: 3-4 days
