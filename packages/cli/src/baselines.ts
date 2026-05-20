import type { ValidationCase, ValidationDataset, ValidationDatasetLoadOptions, ValidationMiss, ValidationRiskMetrics } from "./validate.js";
import type { ValidationDatasetFormat } from "./validate.js";
import { loadValidationDataset } from "./validate.js";

export type ValidationBaselineName =
  | "global-majority"
  | "raw-ngram"
  | "workflow-class-ngram"
  | "semantic-rag-lite"
  | "textual-lesson-prior";

export interface BaselinePrediction {
  predicted: string[];
  predictedRisks: string[];
}

export interface ValidationBaselineReport {
  baseline: ValidationBaselineName;
  description: string;
  dataset: {
    name: string;
    description: string | null;
    path: string;
    format: ValidationDatasetFormat;
    split: ValidationDataset["split"] | null;
  };
  cases: number;
  datasetEvents: number;
  evaluatedSteps: number;
  nextTop1Accuracy: number;
  nextTopKAccuracy: number;
  topK: number;
  missCount: number;
  misses: ValidationMiss[];
  risks: ValidationRiskMetrics;
}

export interface ValidationBaselineComparisonReport {
  baselines: ValidationBaselineReport[];
  bestByAccuracy: {
    baseline: ValidationBaselineName;
    nextTop1Accuracy: number;
    nextTopKAccuracy: number;
    missCount: number;
  } | null;
  bestByRiskRecall: {
    baseline: ValidationBaselineName;
    precision: number | null;
    recall: number | null;
    expectedRiskCount: number;
    predictedRiskCount: number;
  } | null;
}

export interface ValidationBaselineOptions {
  baselines?: ValidationBaselineName[];
  topK?: number;
  maxMisses?: number;
  order?: number;
}

const BASELINE_DESCRIPTIONS: Record<ValidationBaselineName, string> = {
  "global-majority": "Predicts globally frequent next events from training traces, ignoring current state.",
  "raw-ngram": "Predicts next events from exact raw event suffixes with shorter-suffix backoff.",
  "workflow-class-ngram": "Predicts from raw suffixes using only training traces with the same annotated workflow class when possible.",
  "semantic-rag-lite": "Retrieves lexically similar training prefixes from source traces, annotations, projections, and event histories.",
  "textual-lesson-prior": "Predicts from workflow-class and last-event lessons extracted from successful training traces."
};

function sortedCounts(counts: Map<string, number>, limit: number) {
  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([event]) => event);
}

function increment(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sequenceKey(events: string[]) {
  return events.join("\u001f");
}

function workflowClass(validationCase: ValidationCase) {
  return validationCase.annotations?.workflowClass ?? null;
}

function tokenize(value: string | undefined) {
  if (!value) {
    return [];
  }

  return value
    .toLowerCase()
    .split(/[^a-z0-9_.:-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function eventTokens(event: ValidationCase["events"][number]) {
  return [
    event.source,
    event.type,
    event.actor,
    event.outcome,
    ...(event.labels ?? []),
    ...(event.entities ?? []),
    event.projection?.taskClass,
    event.projection?.intent,
    event.projection?.operation,
    event.projection?.artifactClass,
    event.projection?.blockerType,
    ...(event.projection?.entityRoles ?? [])
  ].flatMap((value) => tokenize(value));
}

function caseTokens(validationCase: ValidationCase) {
  return [
    validationCase.caseId,
    validationCase.sourceTrace,
    ...(validationCase.labels ?? []),
    validationCase.annotations?.workflowClass,
    ...(validationCase.annotations?.notes ?? []),
    ...(validationCase.annotations?.blockers ?? []).flatMap((blocker) => [blocker.type, blocker.detail])
  ].flatMap((value) => tokenize(value));
}

function prefixTokens(validationCase: ValidationCase, historyLength: number) {
  return [
    ...caseTokens(validationCase),
    ...validationCase.events.slice(0, historyLength).flatMap((event) => eventTokens(event))
  ];
}

function overlapScore(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.sqrt(leftSet.size * rightSet.size);
}

function matchingTrainingCases(
  trainingCases: ValidationCase[],
  validationCase: ValidationCase,
  baseline: ValidationBaselineName
) {
  if (baseline !== "workflow-class-ngram") {
    return trainingCases;
  }

  const currentClass = workflowClass(validationCase);
  if (!currentClass) {
    return trainingCases;
  }

  const sameClass = trainingCases.filter((candidate) => workflowClass(candidate) === currentClass);
  return sameClass.length > 0 ? sameClass : trainingCases;
}

function buildGlobalCounts(trainingCases: ValidationCase[]) {
  const counts = new Map<string, number>();
  for (const validationCase of trainingCases) {
    for (let index = 1; index < validationCase.events.length; index += 1) {
      const event = validationCase.events[index];
      if (event) {
        increment(counts, event.type);
      }
    }
  }
  return counts;
}

function buildNgramCounts(trainingCases: ValidationCase[], order: number) {
  const countsBySuffix = new Map<string, Map<string, number>>();
  for (const validationCase of trainingCases) {
    const eventTypes = validationCase.events.map((event) => event.type);
    for (let index = 0; index < eventTypes.length - 1; index += 1) {
      const nextEvent = eventTypes[index + 1];
      if (!nextEvent) {
        continue;
      }

      const maxOrder = Math.min(order, index + 1);
      for (let suffixOrder = 1; suffixOrder <= maxOrder; suffixOrder += 1) {
        const suffix = eventTypes.slice(index - suffixOrder + 1, index + 1);
        const key = sequenceKey(suffix);
        const counts = countsBySuffix.get(key) ?? new Map<string, number>();
        increment(counts, nextEvent);
        countsBySuffix.set(key, counts);
      }
    }
  }
  return countsBySuffix;
}

function predictSemanticRag(params: {
  trainingCases: ValidationCase[];
  validationCase: ValidationCase;
  historyLength: number;
  topK: number;
}) {
  const queryTokens = prefixTokens(params.validationCase, params.historyLength);
  const counts = new Map<string, number>();

  for (const trainingCase of params.trainingCases) {
    for (let index = 0; index < trainingCase.events.length - 1; index += 1) {
      const nextEvent = trainingCase.events[index + 1];
      if (!nextEvent) {
        continue;
      }

      const score = overlapScore(queryTokens, prefixTokens(trainingCase, index + 1));
      if (score <= 0) {
        continue;
      }

      increment(counts, nextEvent.type, score);
    }
  }

  return sortedCounts(counts, params.topK);
}

function buildLessonCounts(trainingCases: ValidationCase[]) {
  const byClassAndLast = new Map<string, Map<string, number>>();
  const byClass = new Map<string, Map<string, number>>();

  for (const trainingCase of trainingCases) {
    const className = workflowClass(trainingCase) ?? "unknown";
    for (let index = 0; index < trainingCase.events.length - 1; index += 1) {
      const current = trainingCase.events[index];
      const next = trainingCase.events[index + 1];
      if (!current || !next) {
        continue;
      }

      const classCounts = byClass.get(className) ?? new Map<string, number>();
      increment(classCounts, next.type);
      byClass.set(className, classCounts);

      const key = `${className}\u001f${current.type}`;
      const lastCounts = byClassAndLast.get(key) ?? new Map<string, number>();
      increment(lastCounts, next.type);
      byClassAndLast.set(key, lastCounts);
    }
  }

  return { byClass, byClassAndLast };
}

function predictTextualLesson(params: {
  trainingCases: ValidationCase[];
  validationCase: ValidationCase;
  history: string[];
  topK: number;
}) {
  const className = workflowClass(params.validationCase) ?? "unknown";
  const lastEvent = params.history.at(-1);
  const lessons = buildLessonCounts(params.trainingCases);

  if (lastEvent) {
    const lastCounts = lessons.byClassAndLast.get(`${className}\u001f${lastEvent}`);
    if (lastCounts && lastCounts.size > 0) {
      return sortedCounts(lastCounts, params.topK);
    }
  }

  const classCounts = lessons.byClass.get(className);
  if (classCounts && classCounts.size > 0) {
    return sortedCounts(classCounts, params.topK);
  }

  return sortedCounts(buildGlobalCounts(params.trainingCases), params.topK);
}

function predictNext(params: {
  baseline: ValidationBaselineName;
  trainingCases: ValidationCase[];
  validationCase: ValidationCase;
  history: string[];
  topK: number;
  order: number;
}) {
  const trainingCases = matchingTrainingCases(params.trainingCases, params.validationCase, params.baseline);
  const globalCounts = buildGlobalCounts(trainingCases);

  if (params.baseline === "global-majority") {
    return sortedCounts(globalCounts, params.topK);
  }

  if (params.baseline === "semantic-rag-lite") {
    const predicted = predictSemanticRag({
      trainingCases,
      validationCase: params.validationCase,
      historyLength: params.history.length,
      topK: params.topK
    });
    return predicted.length > 0 ? predicted : sortedCounts(globalCounts, params.topK);
  }

  if (params.baseline === "textual-lesson-prior") {
    return predictTextualLesson({
      trainingCases,
      validationCase: params.validationCase,
      history: params.history,
      topK: params.topK
    });
  }

  const ngramCounts = buildNgramCounts(trainingCases, params.order);
  const maxOrder = Math.min(params.order, params.history.length);
  for (let suffixOrder = maxOrder; suffixOrder >= 1; suffixOrder -= 1) {
    const suffix = params.history.slice(-suffixOrder);
    const counts = ngramCounts.get(sequenceKey(suffix));
    if (counts && counts.size > 0) {
      return sortedCounts(counts, params.topK);
    }
  }

  return sortedCounts(globalCounts, params.topK);
}

function predictRisks(params: {
  baseline: ValidationBaselineName;
  trainingCases: ValidationCase[];
  validationCase: ValidationCase;
  step: number;
  predicted: string[];
  topK: number;
}) {
  if (params.baseline !== "workflow-class-ngram") {
    return [];
  }

  const trainingCases = matchingTrainingCases(params.trainingCases, params.validationCase, params.baseline);
  const riskCounts = new Map<string, number>();
  for (const trainingCase of trainingCases) {
    for (const expectation of trainingCase.annotations?.expectations?.nextByStep ?? []) {
      for (const risk of expectation.expectedRisks ?? []) {
        increment(riskCounts, risk);
      }
    }
  }

  const priorRisks = sortedCounts(riskCounts, params.topK);
  if (priorRisks.length === 0) {
    return [];
  }

  return priorRisks;
}

export function runValidationBaseline(
  dataset: ValidationDataset,
  baseline: ValidationBaselineName,
  options?: ValidationBaselineOptions
): ValidationBaselineReport {
  const topK = options?.topK ?? 3;
  const maxMisses = options?.maxMisses ?? 25;
  const order = options?.order ?? 3;
  let evaluatedSteps = 0;
  let top1Hits = 0;
  let topKHits = 0;
  const misses: ValidationMiss[] = [];
  let riskEvaluatedSteps = 0;
  let expectedRiskCount = 0;
  let predictedRiskCount = 0;
  let truePositiveRiskCount = 0;
  let falsePositiveRiskCount = 0;
  let falseNegativeRiskCount = 0;
  const riskMisses: ValidationRiskMetrics["misses"] = [];
  const riskFalsePositives: ValidationRiskMetrics["falsePositives"] = [];

  for (const validationCase of dataset.cases) {
    const trainingCases = dataset.cases.filter((candidate) => candidate.caseId !== validationCase.caseId);
    const expectationByStep = new Map(
      (validationCase.annotations?.expectations?.nextByStep ?? []).map((expectation) => [expectation.step, expectation])
    );

    for (let index = 0; index < validationCase.events.length - 1; index += 1) {
      const expectedNext = validationCase.events[index + 1];
      if (!expectedNext) {
        continue;
      }

      const history = validationCase.events.slice(0, index + 1).map((event) => event.type);
      const predicted = predictNext({
        baseline,
        trainingCases,
        validationCase,
        history,
        topK,
        order
      });
      const top1 = predicted[0];

      evaluatedSteps += 1;
      if (top1 === expectedNext.type) {
        top1Hits += 1;
      }

      if (predicted.includes(expectedNext.type)) {
        topKHits += 1;
      } else if (misses.length < maxMisses) {
        misses.push({
          caseId: validationCase.caseId,
          step: index + 1,
          expected: expectedNext.type,
          predicted
        });
      }

      const expectation = expectationByStep.get(index + 1);
      const expectedRisks = expectation?.expectedRisks ?? [];
      if (expectedRisks.length > 0) {
        const predictedRisks = predictRisks({
          baseline,
          trainingCases,
          validationCase,
          step: index + 1,
          predicted,
          topK
        });
        const predictedRiskSet = new Set(predictedRisks);
        const expectedRiskSet = new Set(expectedRisks);
        const falsePositives = predictedRisks.filter((risk) => !expectedRiskSet.has(risk));
        const falseNegatives = expectedRisks.filter((risk) => !predictedRiskSet.has(risk));

        riskEvaluatedSteps += 1;
        expectedRiskCount += expectedRisks.length;
        predictedRiskCount += predictedRisks.length;
        truePositiveRiskCount += expectedRisks.filter((risk) => predictedRiskSet.has(risk)).length;
        falsePositiveRiskCount += falsePositives.length;
        falseNegativeRiskCount += falseNegatives.length;

        if (falseNegatives.length > 0 && riskMisses.length < maxMisses) {
          riskMisses.push({
            caseId: validationCase.caseId,
            step: index + 1,
            expectedRisks,
            predictedRisks
          });
        }

        if (falsePositives.length > 0 && riskFalsePositives.length < maxMisses) {
          riskFalsePositives.push({
            caseId: validationCase.caseId,
            step: index + 1,
            expectedRisks,
            predictedRisks
          });
        }
      }
    }
  }

  const datasetEvents = dataset.cases.reduce((sum, validationCase) => sum + validationCase.events.length, 0);

  return {
    baseline,
    description: BASELINE_DESCRIPTIONS[baseline],
    dataset: {
      name: dataset.name,
      description: dataset.description ?? null,
      path: "",
      format: "json",
      split: dataset.split ?? null
    },
    cases: dataset.cases.length,
    datasetEvents,
    evaluatedSteps,
    nextTop1Accuracy: evaluatedSteps === 0 ? 0 : top1Hits / evaluatedSteps,
    nextTopKAccuracy: evaluatedSteps === 0 ? 0 : topKHits / evaluatedSteps,
    topK,
    missCount: evaluatedSteps - topKHits,
    misses,
    risks: {
      evaluatedSteps: riskEvaluatedSteps,
      expectedRiskCount,
      predictedRiskCount,
      truePositiveCount: truePositiveRiskCount,
      falsePositiveCount: falsePositiveRiskCount,
      falseNegativeCount: falseNegativeRiskCount,
      precision: predictedRiskCount === 0 ? null : Number((truePositiveRiskCount / predictedRiskCount).toFixed(3)),
      recall: expectedRiskCount === 0 ? null : Number((truePositiveRiskCount / expectedRiskCount).toFixed(3)),
      misses: riskMisses,
      falsePositives: riskFalsePositives
    }
  };
}

export function runValidationBaselineComparison(
  dataset: ValidationDataset,
  options?: ValidationBaselineOptions
): ValidationBaselineComparisonReport {
  const baselines = options?.baselines ?? [
    "global-majority",
    "raw-ngram",
    "workflow-class-ngram",
    "semantic-rag-lite",
    "textual-lesson-prior"
  ];
  const reports = baselines.map((baseline) => runValidationBaseline(dataset, baseline, options));
  const best = [...reports].sort((left, right) => {
    if (right.nextTop1Accuracy !== left.nextTop1Accuracy) {
      return right.nextTop1Accuracy - left.nextTop1Accuracy;
    }

    if (right.nextTopKAccuracy !== left.nextTopKAccuracy) {
      return right.nextTopKAccuracy - left.nextTopKAccuracy;
    }

    return left.missCount - right.missCount;
  })[0];
  const bestRisk = reports
    .filter((report) => report.risks.expectedRiskCount > 0)
    .sort((left, right) => {
      const leftRecall = left.risks.recall ?? -1;
      const rightRecall = right.risks.recall ?? -1;
      if (rightRecall !== leftRecall) {
        return rightRecall - leftRecall;
      }

      const leftPrecision = left.risks.precision ?? -1;
      const rightPrecision = right.risks.precision ?? -1;
      if (rightPrecision !== leftPrecision) {
        return rightPrecision - leftPrecision;
      }

      return left.missCount - right.missCount;
    })[0];

  return {
    baselines: reports,
    bestByAccuracy: best
      ? {
          baseline: best.baseline,
          nextTop1Accuracy: best.nextTop1Accuracy,
          nextTopKAccuracy: best.nextTopKAccuracy,
          missCount: best.missCount
        }
      : null,
    bestByRiskRecall: bestRisk
      ? {
          baseline: bestRisk.baseline,
          precision: bestRisk.risks.precision,
          recall: bestRisk.risks.recall,
          expectedRiskCount: bestRisk.risks.expectedRiskCount,
          predictedRiskCount: bestRisk.risks.predictedRiskCount
        }
      : null
  };
}

export async function compareBaselineDatasetFile(
  datasetPath: string,
  options?: ValidationDatasetLoadOptions & ValidationBaselineOptions
) {
  const dataset = await loadValidationDataset(datasetPath, options);
  const report = runValidationBaselineComparison(dataset, options);

  return {
    ...report,
    baselines: report.baselines.map((entry) => ({
      ...entry,
      dataset: {
        ...entry.dataset,
        path: datasetPath,
        format: dataset.format
      }
    }))
  };
}

export function parseBaselineList(value: string) {
  const allowed = new Set<ValidationBaselineName>([
    "global-majority",
    "raw-ngram",
    "workflow-class-ngram",
    "semantic-rag-lite",
    "textual-lesson-prior"
  ]);

  return [...new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        if (allowed.has(entry as ValidationBaselineName)) {
          return entry as ValidationBaselineName;
        }

        throw new Error(
          "--baselines must contain only: global-majority, raw-ngram, workflow-class-ngram, semantic-rag-lite, textual-lesson-prior"
        );
      })
  )] as ValidationBaselineName[];
}
