import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertValidationSuiteThresholds, validateSuite } from "./validate-suite.js";

describe("validation suite", () => {
  it("validates all supported datasets in a directory", async () => {
    const report = await validateSuite(path.join(process.cwd(), "fixtures/validation"), {
      topK: 3,
      maxMisses: 1
    });

    expect(report.totals.datasets).toBeGreaterThanOrEqual(3);
    expect(report.datasets.some((dataset) => dataset.dataset.format === "csv")).toBe(true);
    expect(report.datasets.some((dataset) => dataset.dataset.format === "xes")).toBe(true);
    expect(report.totals.evaluatedSteps).toBeGreaterThan(0);
  });

  it("loads a suite manifest with relative dataset paths", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-validate-suite-"));
    const manifestPath = path.join(tempDir, "suite.json");
    const datasetPath = path.join(process.cwd(), "fixtures/validation/simple.csv");

    try {
      await fs.writeFile(
        manifestPath,
        JSON.stringify(
          {
            name: "demo-suite",
            datasets: [
              {
                path: path.relative(tempDir, datasetPath),
                format: "csv",
                name: "simple-csv"
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const report = await validateSuite(manifestPath, {
        topK: 3,
        maxMisses: 1
      });

      expect(report.suite.name).toBe("demo-suite");
      expect(report.datasets[0]?.dataset.name).toBe("simple-csv");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails suite threshold checks when too many datasets regress", () => {
    expect(() =>
      assertValidationSuiteThresholds(
        {
          suite: {
            name: "demo-suite",
            path: "/tmp/suite"
          },
          totals: {
            datasets: 2,
            cases: 4,
            datasetEvents: 10,
            evaluatedSteps: 6,
            nextTop1Accuracy: 0.6,
            nextTopKAccuracy: 0.75,
            missCount: 4
          },
          datasets: [
            {
              dataset: {
                name: "a",
                description: null,
                path: "/tmp/a.csv",
                format: "csv"
              },
              cases: 2,
              datasetEvents: 5,
              evaluatedSteps: 3,
              nextTop1Accuracy: 0.2,
              nextTopKAccuracy: 0.4,
              topK: 3,
              missCount: 2,
              eventBreakdown: [],
              misses: []
            },
            {
              dataset: {
                name: "b",
                description: null,
                path: "/tmp/b.csv",
                format: "csv"
              },
              cases: 2,
              datasetEvents: 5,
              evaluatedSteps: 3,
              nextTop1Accuracy: 0.2,
              nextTopKAccuracy: 0.4,
              topK: 3,
              missCount: 2,
              eventBreakdown: [],
              misses: []
            }
          ]
        },
        {
          minTopKAccuracy: 0.5,
          maxFailingDatasets: 1
        }
      )
    ).toThrow(/failing dataset count/i);
  });
});
