import path from "node:path";

import { describe, expect, it } from "vitest";

import { decideResearchClaims, runResearchGate } from "./research-gate.js";
import type { ValidationBaselineComparisonReport } from "./baselines.js";
import type { ValidationComparisonReport } from "./validate.js";

describe("research gate", () => {
  it("emits thesis decisions from Sherpa and baseline comparisons", () => {
    const sherpa: ValidationComparisonReport = {
      strategies: [
        {
          stateStrategy: "raw",
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
          nextTop1Accuracy: 0.75,
          nextTopKAccuracy: 1,
          topK: 3,
          missCount: 0,
          eventBreakdown: [],
          misses: [],
          research: {
            support: {
              matchedSteps: 4,
              unmatchedSteps: 0,
              averageCandidateCount: 1,
              averageTotalSupport: 2,
              averageTopCandidateSupport: 2,
              averageMatchedOrder: 2,
              averageGraphStates: 4,
              minGraphStates: 4,
              maxGraphStates: 4
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
          }
        },
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
          nextTop1Accuracy: 0.75,
          nextTopKAccuracy: 1,
          topK: 3,
          missCount: 0,
          eventBreakdown: [],
          misses: [],
          research: {
            support: {
              matchedSteps: 4,
              unmatchedSteps: 0,
              averageCandidateCount: 1,
              averageTotalSupport: 2,
              averageTopCandidateSupport: 2,
              averageMatchedOrder: 2,
              averageGraphStates: 4,
              minGraphStates: 4,
              maxGraphStates: 4
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
          }
        }
      ],
      bestByAccuracy: {
        stateStrategy: "raw",
        nextTop1Accuracy: 0.75,
        nextTopKAccuracy: 1,
        missCount: 0
      },
      bestByRiskRecall: null,
      bestBySupportDensity: {
        stateStrategy: "raw",
        averageTotalSupport: 2,
        averageTopCandidateSupport: 2,
        averageGraphStates: 4
      }
    };
    const baselines: ValidationBaselineComparisonReport = {
      baselines: [
        {
          baseline: "global-majority",
          description: "demo",
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
          misses: [],
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
        }
      ],
      bestByAccuracy: {
        baseline: "global-majority",
        nextTop1Accuracy: 0.25,
        nextTopKAccuracy: 0.5,
        missCount: 2
      },
      bestByRiskRecall: null
    };

    const claims = decideResearchClaims({ sherpa, baselines });

    expect(claims.find((claim) => claim.id === "H1")?.decision).toBe("supported");
    expect(claims.find((claim) => claim.id === "H2")?.decision).toBe("supported");
    expect(claims.find((claim) => claim.id === "H3")?.decision).toBe("supported");
    expect(claims.find((claim) => claim.id === "H4")?.decision).toBe("pending");
  });

  it("runs the gate against a real validation fixture", async () => {
    const report = await runResearchGate(
      path.join(process.cwd(), "fixtures/validation/openclaw-realish.json"),
      {
        strategies: ["raw", "procedure", "family-procedure"],
        baselines: ["global-majority", "raw-ngram", "workflow-class-ngram"],
        topK: 3,
        maxMisses: 2
      }
    );

    expect(report.claims).toHaveLength(5);
    expect(report.sherpa.bestByAccuracy).not.toBeNull();
    expect(report.baselines.bestByAccuracy).not.toBeNull();
  }, 15000);
});
