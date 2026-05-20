import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ValidationDataset, ValidationResearchMetrics } from "./validate.js";
import { assertValidationThresholds, loadValidationDataset, runValidationComparison, runValidationDataset } from "./validate.js";

function emptyResearchMetrics(): ValidationResearchMetrics {
  return {
    support: {
      matchedSteps: 0,
      unmatchedSteps: 0,
      averageCandidateCount: 0,
      averageTotalSupport: 0,
      averageTopCandidateSupport: 0,
      averageMatchedOrder: 0,
      averageGraphStates: 0,
      minGraphStates: 0,
      maxGraphStates: 0
    },
    matchBreakdown: [],
    risks: {
      evaluatedSteps: 0,
      expectedRiskCount: 0,
      predictedRiskCount: 0,
      truePositiveCount: 0,
      falsePositiveCount: 0,
      falseNegativeCount: 0,
      precision: null,
      recall: null,
      misses: [],
      falsePositives: []
    }
  };
}

describe("validation harness", () => {
  it("loads JSONL datasets and groups events by case", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-validate-fixture-"));
    const datasetPath = path.join(tempDir, "events.jsonl");

    try {
      await fs.writeFile(
        datasetPath,
        [
          JSON.stringify({ caseId: "case-1", source: "openclaw.dispatch", type: "request.received" }),
          JSON.stringify({ caseId: "case-1", source: "tool.repo", type: "repo.inspected" }),
          JSON.stringify({ caseId: "case-2", source: "openclaw.dispatch", type: "request.received" })
        ].join("\n")
      );

      const dataset = await loadValidationDataset(datasetPath);
      expect(dataset.name).toBe("events");
      expect(dataset.cases).toHaveLength(2);
      expect(dataset.cases[0]?.events).toHaveLength(2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads CSV datasets using column headers", async () => {
    const dataset = await loadValidationDataset(
      path.join(process.cwd(), "fixtures/validation/simple.csv")
    );

    expect(dataset.format).toBe("csv");
    expect(dataset.cases).toHaveLength(2);
    expect(dataset.cases[0]).toMatchObject({
      caseId: "csv-1"
    });
    expect(dataset.cases[0]?.events[2]).toMatchObject({
      type: "task.completed",
      outcome: "success"
    });
  });

  it("loads XES datasets using standard XES attributes", async () => {
    const dataset = await loadValidationDataset(
      path.join(process.cwd(), "fixtures/validation/simple.xes")
    );

    expect(dataset.format).toBe("xes");
    expect(dataset.cases).toHaveLength(2);
    expect(dataset.cases[1]).toMatchObject({
      caseId: "xes-2"
    });
    expect(dataset.cases[1]?.events[1]).toMatchObject({
      type: "task.failed",
      outcome: "failure"
    });
  });

  it("preserves authored order for untimestamped JSON case events", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-validate-fixture-"));
    const datasetPath = path.join(tempDir, "events.json");

    try {
      await fs.writeFile(
        datasetPath,
        JSON.stringify({
          name: "untimestamped-order",
          cases: [
            {
              caseId: "case-1",
              events: [
                { source: "tool", type: "request.received" },
                { source: "tool", type: "repo.inspected" },
                { source: "tool", type: "tests.run" },
                { source: "tool", type: "patch.applied" }
              ]
            }
          ]
        }),
        "utf8"
      );

      const dataset = await loadValidationDataset(datasetPath);

      expect(dataset.cases[0]?.events.map((event) => event.type)).toEqual([
        "request.received",
        "repo.inspected",
        "tests.run",
        "patch.applied"
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads annotated JSON validation datasets without dropping metadata", async () => {
    const dataset = await loadValidationDataset(
      path.join(process.cwd(), "fixtures/validation/openclaw-realish.json")
    );

    expect(dataset.format).toBe("json");
    expect(dataset.schemaVersion).toBe(1);
    expect(dataset.ontologyVersion).toBe("draft-v1");
    expect(dataset.notes).toContain("Starter real-world-like traces for schema and evaluation development.");
    expect(dataset.cases[0]).toMatchObject({
      caseId: "incident-config-recovery-1",
      sourceTrace: "openclaw-dogfood",
      labels: ["workflow:incident-response", "domain:payments"],
      annotations: {
        workflowClass: "incident-response",
        expectations: {
          terminalOutcome: "success"
        }
      }
    });
    expect(dataset.cases[0]?.annotations?.blockers?.[0]).toMatchObject({
      step: 5,
      type: "config-drift"
    });
    expect(dataset.cases[0]?.annotations?.taskBoundaries?.[0]).toMatchObject({
      startStep: 1,
      endStep: 8,
      title: "Stripe webhook failures after deploy"
    });
  });

  it("loads fixed split metadata from research fixtures", async () => {
    const dataset = await loadValidationDataset(
      path.join(process.cwd(), "fixtures/validation/openclaw-real-test.json")
    );

    expect(dataset.split).toBe("test");
    expect(dataset.cases).toEqual([]);
  });

  it("reports next-step accuracy for repeated synthetic traces", async () => {
    const report = await runValidationDataset(
      {
        name: "simple",
        cases: [
          {
            caseId: "case-1",
            events: [
              { caseId: "case-1", source: "openclaw.dispatch", type: "request.received" },
              { caseId: "case-1", source: "tool.repo", type: "repo.inspected" },
              { caseId: "case-1", source: "tool.edit", type: "patch.applied", outcome: "success" }
            ]
          },
          {
            caseId: "case-2",
            events: [
              { caseId: "case-2", source: "openclaw.dispatch", type: "request.received" },
              { caseId: "case-2", source: "tool.repo", type: "repo.inspected" },
              { caseId: "case-2", source: "tool.edit", type: "patch.applied", outcome: "success" }
            ]
          }
        ]
      },
      {
        defaultOrder: 2,
        minOrder: 1,
        maxOrder: 2,
        topK: 3
      }
    );

    expect(report.cases).toBe(2);
    expect(report.evaluatedSteps).toBe(4);
    expect(report.stateStrategy).toBe("family-procedure");
    expect(report.nextTop1Accuracy).toBeGreaterThanOrEqual(0);
    expect(report.nextTop1Accuracy).toBeLessThanOrEqual(1);
    expect(report.nextTopKAccuracy).toBeGreaterThanOrEqual(report.nextTop1Accuracy);
    expect(report.nextTopKAccuracy).toBeLessThanOrEqual(1);
    expect(report.research.support.matchedSteps + report.research.support.unmatchedSteps).toBe(report.evaluatedSteps);
    expect(report.research.support.averageGraphStates).toBeGreaterThanOrEqual(0);
    expect(report.research.matchBreakdown.length).toBeGreaterThan(0);
    expect(report.research.risks.evaluatedSteps).toBe(0);
    expect(report.missCount).toBe(report.evaluatedSteps - report.eventBreakdown.reduce((sum, row) => sum + row.topKHits, 0));
    expect(report.eventBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "repo.inspected",
          occurrences: 2
        }),
        expect.objectContaining({
          event: "patch.applied",
          occurrences: 2
        })
      ])
    );
    expect(report.misses.length).toBeLessThanOrEqual(report.evaluatedSteps);
  });

  it("uses deterministic validation event identities for untimestamped traces", async () => {
    const dataset: ValidationDataset = {
      name: "deterministic",
      cases: [
        {
          caseId: "case-1",
          events: [
            { caseId: "case-1", source: "tool", type: "request.received" },
            { caseId: "case-1", source: "tool", type: "repo.inspected" },
            { caseId: "case-1", source: "tool", type: "patch.applied", outcome: "success" }
          ]
        },
        {
          caseId: "case-2",
          events: [
            { caseId: "case-2", source: "tool", type: "request.received" },
            { caseId: "case-2", source: "tool", type: "repo.inspected" },
            { caseId: "case-2", source: "tool", type: "patch.applied", outcome: "success" }
          ]
        }
      ]
    };

    const first = await runValidationDataset(dataset, {
      defaultOrder: 2,
      minOrder: 1,
      maxOrder: 2,
      topK: 3
    });
    const second = await runValidationDataset(dataset, {
      defaultOrder: 2,
      minOrder: 1,
      maxOrder: 2,
      topK: 3
    });

    expect(second).toEqual(first);
  });

  it("compares multiple validation state strategies on the same dataset", async () => {
    const dataset: ValidationDataset = {
      name: "strategy-compare",
      cases: [
        {
          caseId: "case-1",
          events: [
            {
              caseId: "case-1",
              source: "openclaw.dispatch",
              type: "message.received",
              projection: {
                taskClass: "code-fix",
                operation: "message-received",
                source: "manual",
                version: "draft-v1"
              }
            },
            {
              caseId: "case-1",
              source: "tool.repo",
              type: "tool.succeeded",
              projection: {
                taskClass: "code-fix",
                operation: "repo-inspect",
                source: "manual",
                version: "draft-v1"
              }
            },
            {
              caseId: "case-1",
              source: "tool.exec",
              type: "tool.succeeded",
              outcome: "success",
              projection: {
                taskClass: "code-fix",
                operation: "tests-run",
                source: "manual",
                version: "draft-v1"
              }
            }
          ]
        },
        {
          caseId: "case-2",
          events: [
            {
              caseId: "case-2",
              source: "openclaw.dispatch",
              type: "message.received",
              projection: {
                taskClass: "code-fix",
                operation: "message-received",
                source: "manual",
                version: "draft-v1"
              }
            },
            {
              caseId: "case-2",
              source: "tool.repo",
              type: "tool.succeeded",
              projection: {
                taskClass: "code-fix",
                operation: "repo-inspect",
                source: "manual",
                version: "draft-v1"
              }
            },
            {
              caseId: "case-2",
              source: "tool.exec",
              type: "tool.succeeded",
              outcome: "success",
              projection: {
                taskClass: "code-fix",
                operation: "tests-run",
                source: "manual",
                version: "draft-v1"
              }
            }
          ]
        }
      ]
    };

    const report = await runValidationComparison(dataset, {
      strategies: ["raw", "procedure", "family-procedure"],
      defaultOrder: 2,
      minOrder: 1,
      maxOrder: 2,
      topK: 3
    });

    expect(report.strategies.map((entry) => entry.stateStrategy)).toEqual([
      "raw",
      "procedure",
      "family-procedure"
    ]);
    expect(report.bestByAccuracy).not.toBeNull();
    expect(report.bestBySupportDensity).not.toBeNull();
    expect(report.bestByRiskRecall).toBeNull();
    expect(report.strategies[0]?.evaluatedSteps).toBeGreaterThan(0);
  });

  it("caps miss examples while preserving total miss count", async () => {
    const report = await runValidationDataset(
      {
        name: "miss-heavy",
        cases: [
          {
            caseId: "case-1",
            events: [
              { caseId: "case-1", source: "tool", type: "a" },
              { caseId: "case-1", source: "tool", type: "b" },
              { caseId: "case-1", source: "tool", type: "c" }
            ]
          },
          {
            caseId: "case-2",
            events: [
              { caseId: "case-2", source: "tool", type: "x" },
              { caseId: "case-2", source: "tool", type: "y" },
              { caseId: "case-2", source: "tool", type: "z" }
            ]
          }
        ]
      },
      {
        maxMisses: 1
      }
    );

    expect(report.missCount).toBeGreaterThanOrEqual(report.misses.length);
    expect(report.misses).toHaveLength(1);
  });

  it("reports annotated risk precision and recall counters", async () => {
    const dataset = await loadValidationDataset(
      path.join(process.cwd(), "fixtures/validation/openclaw-realish.json")
    );
    const report = await runValidationDataset(dataset, {
      topK: 3,
      maxMisses: 2
    });

    expect(report.research.risks.evaluatedSteps).toBeGreaterThan(0);
    expect(report.research.risks.expectedRiskCount).toBeGreaterThan(0);
    expect(report.research.risks.misses.length).toBeLessThanOrEqual(2);
    expect(report.research.risks.falsePositives.length).toBeLessThanOrEqual(2);
  });

  it("fails threshold checks when validation metrics regress below required bounds", () => {
    expect(() =>
      assertValidationThresholds(
        {
          stateStrategy: "family-procedure",
          dataset: {
            name: "demo",
            description: null,
            path: "demo.json",
            format: "json",
            split: null
          },
          cases: 2,
          datasetEvents: 6,
          evaluatedSteps: 4,
          nextTop1Accuracy: 0.25,
          nextTopKAccuracy: 0.5,
          topK: 3,
          missCount: 2,
          eventBreakdown: [],
          misses: [],
          research: emptyResearchMetrics()
        },
        {
          minTop1Accuracy: 0.4
        }
      )
    ).toThrow(/top1 accuracy/i);

    expect(() =>
      assertValidationThresholds(
        {
          stateStrategy: "family-procedure",
          dataset: {
            name: "demo",
            description: null,
            path: "demo.json",
            format: "json",
            split: null
          },
          cases: 2,
          datasetEvents: 6,
          evaluatedSteps: 4,
          nextTop1Accuracy: 0.5,
          nextTopKAccuracy: 0.75,
          topK: 3,
          missCount: 1,
          eventBreakdown: [],
          misses: [],
          research: emptyResearchMetrics()
        },
        {
          minTop1Accuracy: 0.4,
          minTopKAccuracy: 0.7,
          maxMissCount: 2
        }
      )
    ).not.toThrow();
  });
});
