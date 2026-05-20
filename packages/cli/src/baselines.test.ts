import path from "node:path";

import { describe, expect, it } from "vitest";

import { compareBaselineDatasetFile, parseBaselineList, runValidationBaselineComparison } from "./baselines.js";
import type { ValidationDataset } from "./validate.js";

describe("validation baselines", () => {
  it("compares non-Sherpa baseline predictors on the same dataset", () => {
    const dataset: ValidationDataset = {
      name: "baseline-demo",
      cases: [
        {
          caseId: "case-1",
          annotations: {
            workflowClass: "code-fix"
          },
          events: [
            { caseId: "case-1", source: "tool", type: "request.received" },
            { caseId: "case-1", source: "tool", type: "repo.inspected" },
            { caseId: "case-1", source: "tool", type: "tests.run" }
          ]
        },
        {
          caseId: "case-2",
          annotations: {
            workflowClass: "code-fix"
          },
          events: [
            { caseId: "case-2", source: "tool", type: "request.received" },
            { caseId: "case-2", source: "tool", type: "repo.inspected" },
            { caseId: "case-2", source: "tool", type: "tests.run" }
          ]
        }
      ]
    };

    const report = runValidationBaselineComparison(dataset, {
      baselines: ["global-majority", "raw-ngram", "workflow-class-ngram", "semantic-rag-lite", "textual-lesson-prior"],
      topK: 3,
      order: 2
    });

    expect(report.baselines.map((baseline) => baseline.baseline)).toEqual([
      "global-majority",
      "raw-ngram",
      "workflow-class-ngram",
      "semantic-rag-lite",
      "textual-lesson-prior"
    ]);
    expect(report.bestByAccuracy).not.toBeNull();
    expect(report.baselines[1]?.nextTopKAccuracy).toBe(1);
  });

  it("uses lexical case context for the semantic-rag-lite baseline", () => {
    const dataset: ValidationDataset = {
      name: "semantic-rag-demo",
      cases: [
        {
          caseId: "docs-a",
          sourceTrace: "Update validation docs after fixture changes",
          events: [
            { caseId: "docs-a", source: "message", type: "request.received", labels: ["docs"] },
            { caseId: "docs-a", source: "tool", type: "docs.opened", labels: ["validation"] },
            { caseId: "docs-a", source: "tool", type: "docs.updated" }
          ]
        },
        {
          caseId: "docs-b",
          sourceTrace: "Refresh validation guide after schema edits",
          events: [
            { caseId: "docs-b", source: "message", type: "request.received", labels: ["docs"] },
            { caseId: "docs-b", source: "tool", type: "docs.opened", labels: ["validation"] },
            { caseId: "docs-b", source: "tool", type: "docs.updated" }
          ]
        },
        {
          caseId: "tests-c",
          sourceTrace: "Run failing test suite after code changes",
          events: [
            { caseId: "tests-c", source: "message", type: "request.received", labels: ["tests"] },
            { caseId: "tests-c", source: "tool", type: "tests.run" },
            { caseId: "tests-c", source: "tool", type: "test.failure.triaged" }
          ]
        }
      ]
    };

    const report = runValidationBaselineComparison(dataset, {
      baselines: ["semantic-rag-lite"],
      topK: 1,
      order: 2
    });

    expect(report.baselines[0]?.nextTopKAccuracy).toBeGreaterThan(0);
  });

  it("reports workflow-class risk priors for annotated risk expectations", async () => {
    const report = await compareBaselineDatasetFile(
      path.join(process.cwd(), "fixtures/validation/openclaw-realish.json"),
      {
        baselines: ["workflow-class-ngram"],
        topK: 3,
        maxMisses: 2
      }
    );

    expect(report.baselines[0]?.risks.evaluatedSteps).toBeGreaterThan(0);
    expect(report.bestByRiskRecall).not.toBeNull();
  });

  it("parses baseline lists with de-duplication", () => {
    expect(parseBaselineList("raw-ngram,global-majority,raw-ngram,semantic-rag-lite")).toEqual([
      "raw-ngram",
      "global-majority",
      "semantic-rag-lite"
    ]);
    expect(() => parseBaselineList("unknown")).toThrow(/--baselines/);
  });
});
