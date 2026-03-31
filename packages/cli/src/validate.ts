import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SherpaEngine, type SherpaEventInput } from "@sherpa/core";

export interface ValidationCase {
  caseId: string;
  events: SherpaEventInput[];
}

export interface ValidationDataset {
  name: string;
  description?: string;
  cases: ValidationCase[];
}

export interface ValidationMiss {
  caseId: string;
  step: number;
  expected: string;
  predicted: string[];
}

export interface ValidationReport {
  dataset: {
    name: string;
    description: string | null;
    path: string;
  };
  cases: number;
  datasetEvents: number;
  evaluatedSteps: number;
  nextTop1Accuracy: number;
  nextTopKAccuracy: number;
  topK: number;
  misses: ValidationMiss[];
}

function groupEventsByCase(events: SherpaEventInput[]): ValidationCase[] {
  const grouped = new Map<string, SherpaEventInput[]>();

  for (const event of events) {
    const caseId = String(event.caseId ?? "");
    if (!caseId) {
      throw new Error("Validation events must include caseId");
    }

    const bucket = grouped.get(caseId);
    if (bucket) {
      bucket.push(event);
    } else {
      grouped.set(caseId, [event]);
    }
  }

  return [...grouped.entries()].map(([caseId, caseEvents]) => ({
    caseId,
    events: caseEvents
  }));
}

function normalizeCaseEvents(validationCase: Record<string, unknown>) {
  const caseId = String(validationCase.caseId ?? "");
  if (!caseId) {
    throw new Error("Validation case is missing caseId");
  }

  const events = Array.isArray(validationCase.events) ? validationCase.events : [];
  return {
    caseId,
    events: events.map((event) => ({
      ...(event as SherpaEventInput),
      caseId
    }))
  };
}

export async function loadValidationDataset(datasetPath: string): Promise<ValidationDataset> {
  const raw = await fs.readFile(datasetPath, "utf8");

  if (datasetPath.endsWith(".jsonl")) {
    const events = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SherpaEventInput);

    return {
      name: path.basename(datasetPath, path.extname(datasetPath)),
      cases: groupEventsByCase(events)
    };
  }

  const parsed = JSON.parse(raw) as
    | SherpaEventInput[]
    | {
        name?: string;
        description?: string;
        cases?: Array<Record<string, unknown>>;
      };

  if (Array.isArray(parsed)) {
    return {
      name: path.basename(datasetPath, path.extname(datasetPath)),
      cases: groupEventsByCase(parsed)
    };
  }

  return {
    name: parsed.name ?? path.basename(datasetPath, path.extname(datasetPath)),
    ...(parsed.description ? { description: parsed.description } : {}),
    cases: Array.isArray(parsed.cases) ? parsed.cases.map(normalizeCaseEvents) : []
  };
}

export async function runValidationDataset(
  dataset: ValidationDataset,
  options?: {
    rootParent?: string;
    defaultOrder?: number;
    minOrder?: number;
    maxOrder?: number;
    minSupport?: number;
    topK?: number;
  }
): Promise<ValidationReport> {
  const topK = options?.topK ?? 3;
  let evaluatedSteps = 0;
  let top1Hits = 0;
  let topKHits = 0;
  const misses: ValidationMiss[] = [];

  for (const validationCase of dataset.cases) {
    if (validationCase.events.length < 2) {
      continue;
    }

    const tempParent = options?.rootParent ?? os.tmpdir();
    await fs.mkdir(tempParent, { recursive: true });
    const tempRoot = await fs.mkdtemp(path.join(tempParent, "sherpa-validate-"));
    const engine = new SherpaEngine({
      rootDir: tempRoot,
      ...(options?.defaultOrder !== undefined ? { defaultOrder: options.defaultOrder } : {}),
      ...(options?.minOrder !== undefined ? { minOrder: options.minOrder } : {}),
      ...(options?.maxOrder !== undefined ? { maxOrder: options.maxOrder } : {}),
      ...(options?.minSupport !== undefined ? { minSupport: options.minSupport } : {})
    });

    try {
      const trainingEvents = dataset.cases
        .filter((candidate) => candidate.caseId !== validationCase.caseId)
        .flatMap((candidate) => candidate.events);

      if (trainingEvents.length > 0) {
        await engine.ingestBatch(trainingEvents);
      } else {
        await engine.init();
      }

      for (let index = 0; index < validationCase.events.length - 1; index += 1) {
        await engine.ingest(validationCase.events[index] as SherpaEventInput);

        const expectedNext = validationCase.events[index + 1];
        if (!expectedNext) {
          continue;
        }

        const result = await engine.workflowNext(validationCase.caseId, topK);
        const predicted = result.candidates.map((candidate) => candidate.event);
        const top1 = predicted[0];

        evaluatedSteps += 1;

        if (top1 === expectedNext.type) {
          top1Hits += 1;
        }

        if (predicted.includes(expectedNext.type)) {
          topKHits += 1;
        } else {
          misses.push({
            caseId: validationCase.caseId,
            step: index + 1,
            expected: expectedNext.type,
            predicted
          });
        }
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  const datasetEvents = dataset.cases.reduce((sum, validationCase) => sum + validationCase.events.length, 0);

  return {
    dataset: {
      name: dataset.name,
      description: dataset.description ?? null,
      path: ""
    },
    cases: dataset.cases.length,
    datasetEvents,
    evaluatedSteps,
    nextTop1Accuracy: evaluatedSteps === 0 ? 0 : top1Hits / evaluatedSteps,
    nextTopKAccuracy: evaluatedSteps === 0 ? 0 : topKHits / evaluatedSteps,
    topK,
    misses
  };
}

export async function validateDatasetFile(
  datasetPath: string,
  options?: {
    rootParent?: string;
    defaultOrder?: number;
    minOrder?: number;
    maxOrder?: number;
    minSupport?: number;
    topK?: number;
  }
) {
  const dataset = await loadValidationDataset(datasetPath);
  const report = await runValidationDataset(dataset, options);

  return {
    ...report,
    dataset: {
      ...report.dataset,
      path: datasetPath
    }
  };
}
