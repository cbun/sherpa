import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadValidationDataset, runValidationDataset } from "./validate.js";

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
    expect(report.nextTop1Accuracy).toBeGreaterThanOrEqual(0);
    expect(report.nextTop1Accuracy).toBeLessThanOrEqual(1);
    expect(report.nextTopKAccuracy).toBeGreaterThanOrEqual(report.nextTop1Accuracy);
    expect(report.nextTopKAccuracy).toBeLessThanOrEqual(1);
    expect(report.misses.length).toBeLessThanOrEqual(report.evaluatedSteps);
  });
});
