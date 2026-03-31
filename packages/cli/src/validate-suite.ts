import fs from "node:fs/promises";
import path from "node:path";

import { type ValidationDatasetLoadOptions, type ValidationReport, type ValidationThresholds, assertValidationThresholds, validateDatasetFile } from "./validate.js";

export interface ValidationSuiteDatasetEntry extends ValidationDatasetLoadOptions {
  path: string;
  name?: string;
}

export interface ValidationSuiteManifest {
  name?: string;
  datasets: ValidationSuiteDatasetEntry[];
}

export interface ValidationSuiteReport {
  suite: {
    name: string;
    path: string;
  };
  totals: {
    datasets: number;
    cases: number;
    datasetEvents: number;
    evaluatedSteps: number;
    nextTop1Accuracy: number;
    nextTopKAccuracy: number;
    missCount: number;
  };
  datasets: Array<ValidationReport & { dataset: ValidationReport["dataset"] & { name: string } }>;
}

export interface ValidationSuiteThresholds extends ValidationThresholds {
  maxFailingDatasets?: number;
}

const SUPPORTED_EXTENSIONS = new Set([".json", ".jsonl", ".csv", ".xes"]);

async function collectDatasetFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const target = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDatasetFiles(target)));
      continue;
    }

    if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(target);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function loadSuiteEntries(inputPath: string): Promise<{ name: string; datasets: ValidationSuiteDatasetEntry[] }> {
  const stat = await fs.stat(inputPath);

  if (stat.isDirectory()) {
    const datasets = (await collectDatasetFiles(inputPath)).map((datasetPath) => ({
      path: datasetPath
    }));

    return {
      name: path.basename(inputPath),
      datasets
    };
  }

  const raw = await fs.readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw) as ValidationSuiteManifest;
  if (!Array.isArray(parsed.datasets)) {
    throw new Error("Validation suite manifest must contain a datasets array");
  }

  return {
    name: parsed.name ?? path.basename(inputPath, path.extname(inputPath)),
    datasets: parsed.datasets.map((entry) => ({
      ...entry,
      path: path.resolve(path.dirname(inputPath), entry.path)
    }))
  };
}

export async function validateSuite(
  inputPath: string,
  options?: ValidationDatasetLoadOptions & {
    rootParent?: string;
    defaultOrder?: number;
    minOrder?: number;
    maxOrder?: number;
    minSupport?: number;
    topK?: number;
    maxMisses?: number;
  }
): Promise<ValidationSuiteReport> {
  const suite = await loadSuiteEntries(inputPath);
  const datasets: ValidationSuiteReport["datasets"] = [];

  for (const entry of suite.datasets) {
    const report = await validateDatasetFile(entry.path, {
      ...options,
      ...entry
    });
    datasets.push({
      ...report,
      dataset: {
        ...report.dataset,
        name: entry.name ?? report.dataset.name
      }
    });
  }

  const totals = datasets.reduce(
    (sum, report) => {
      sum.datasets += 1;
      sum.cases += report.cases;
      sum.datasetEvents += report.datasetEvents;
      sum.evaluatedSteps += report.evaluatedSteps;
      sum.missCount += report.missCount;
      sum.top1Hits += report.nextTop1Accuracy * report.evaluatedSteps;
      sum.topKHits += report.nextTopKAccuracy * report.evaluatedSteps;
      return sum;
    },
    {
      datasets: 0,
      cases: 0,
      datasetEvents: 0,
      evaluatedSteps: 0,
      missCount: 0,
      top1Hits: 0,
      topKHits: 0
    }
  );

  return {
    suite: {
      name: suite.name,
      path: inputPath
    },
    totals: {
      datasets: totals.datasets,
      cases: totals.cases,
      datasetEvents: totals.datasetEvents,
      evaluatedSteps: totals.evaluatedSteps,
      nextTop1Accuracy: totals.evaluatedSteps === 0 ? 0 : Number((totals.top1Hits / totals.evaluatedSteps).toFixed(3)),
      nextTopKAccuracy: totals.evaluatedSteps === 0 ? 0 : Number((totals.topKHits / totals.evaluatedSteps).toFixed(3)),
      missCount: totals.missCount
    },
    datasets
  };
}

export function assertValidationSuiteThresholds(
  report: ValidationSuiteReport,
  thresholds?: ValidationSuiteThresholds
) {
  if (!thresholds) {
    return;
  }

  const failingDatasets = report.datasets.filter((dataset) => {
    try {
      assertValidationThresholds(dataset, thresholds);
      return false;
    } catch {
      return true;
    }
  });

  assertValidationThresholds(
    {
      dataset: {
        name: report.suite.name,
        description: null,
        path: report.suite.path,
        format: "json"
      },
      cases: report.totals.cases,
      datasetEvents: report.totals.datasetEvents,
      evaluatedSteps: report.totals.evaluatedSteps,
      nextTop1Accuracy: report.totals.nextTop1Accuracy,
      nextTopKAccuracy: report.totals.nextTopKAccuracy,
      topK: 0,
      missCount: report.totals.missCount,
      eventBreakdown: [],
      misses: []
    },
    thresholds
  );

  if (
    typeof thresholds.maxFailingDatasets === "number" &&
    failingDatasets.length > thresholds.maxFailingDatasets
  ) {
    throw new Error(
      `Validation suite failing dataset count ${failingDatasets.length} exceeds allowed maximum ${thresholds.maxFailingDatasets}`
    );
  }
}
