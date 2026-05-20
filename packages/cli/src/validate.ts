import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseCsv } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";

import { SherpaEngine, type SherpaEventInput, type SherpaOutcome, type SherpaStateStrategy } from "@sherpa/core";

export interface ValidationTaskBoundary {
  startStep: number;
  endStep?: number;
  title?: string;
  reason?: string;
}

export interface ValidationBlocker {
  step: number;
  type: string;
  detail?: string;
  resolved?: boolean;
}

export interface ValidationStepExpectation {
  step: number;
  expectedNext?: string[];
  expectedRisks?: string[];
  note?: string;
}

export interface ValidationCaseAnnotations {
  workflowClass?: string;
  taskBoundaries?: ValidationTaskBoundary[];
  blockers?: ValidationBlocker[];
  expectations?: {
    nextByStep?: ValidationStepExpectation[];
    terminalOutcome?: SherpaOutcome;
  };
  notes?: string[];
}

export interface ValidationCase {
  caseId: string;
  events: SherpaEventInput[];
  labels?: string[];
  sourceTrace?: string;
  annotations?: ValidationCaseAnnotations;
}

export interface ValidationDataset {
  name: string;
  description?: string;
  schemaVersion?: number;
  ontologyVersion?: string;
  split?: "train" | "dev" | "test";
  notes?: string[];
  cases: ValidationCase[];
}

export interface ValidationMiss {
  caseId: string;
  step: number;
  expected: string;
  predicted: string[];
}

export interface ValidationRiskMiss {
  caseId: string;
  step: number;
  expectedRisks: string[];
  predictedRisks: string[];
}

export interface ValidationRiskFalsePositive {
  caseId: string;
  step: number;
  expectedRisks: string[];
  predictedRisks: string[];
}

export interface ValidationEventBreakdown {
  event: string;
  occurrences: number;
  top1Hits: number;
  topKHits: number;
  top1Accuracy: number;
  topKAccuracy: number;
}

export interface ValidationMatchBreakdown {
  mode: "projected" | "raw" | "none";
  matchedOrder: number;
  occurrences: number;
  share: number;
}

export interface ValidationSupportMetrics {
  matchedSteps: number;
  unmatchedSteps: number;
  averageCandidateCount: number;
  averageTotalSupport: number;
  averageTopCandidateSupport: number;
  averageMatchedOrder: number;
  averageGraphStates: number;
  minGraphStates: number;
  maxGraphStates: number;
}

export interface ValidationRiskMetrics {
  evaluatedSteps: number;
  expectedRiskCount: number;
  predictedRiskCount: number;
  truePositiveCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  precision: number | null;
  recall: number | null;
  misses: ValidationRiskMiss[];
  falsePositives: ValidationRiskFalsePositive[];
}

export interface ValidationResearchMetrics {
  support: ValidationSupportMetrics;
  matchBreakdown: ValidationMatchBreakdown[];
  risks: ValidationRiskMetrics;
}

export interface ValidationThresholds {
  minTop1Accuracy?: number;
  minTopKAccuracy?: number;
  maxMissCount?: number;
}

export interface ValidationReport {
  stateStrategy: SherpaStateStrategy;
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
  eventBreakdown: ValidationEventBreakdown[];
  misses: ValidationMiss[];
  research: ValidationResearchMetrics;
}

export interface ValidationComparisonReport {
  strategies: ValidationReport[];
  bestByAccuracy: {
    stateStrategy: SherpaStateStrategy;
    nextTop1Accuracy: number;
    nextTopKAccuracy: number;
    missCount: number;
  } | null;
  bestByRiskRecall: {
    stateStrategy: SherpaStateStrategy;
    precision: number | null;
    recall: number | null;
    expectedRiskCount: number;
    predictedRiskCount: number;
  } | null;
  bestBySupportDensity: {
    stateStrategy: SherpaStateStrategy;
    averageTotalSupport: number;
    averageTopCandidateSupport: number;
    averageGraphStates: number;
  } | null;
}

export type ValidationDatasetFormat = "json" | "jsonl" | "csv" | "xes";

export interface ValidationDatasetLoadOptions {
  format?: ValidationDatasetFormat | "auto";
  caseField?: string;
  typeField?: string;
  timestampField?: string;
  outcomeField?: string;
  sourceField?: string;
  agentField?: string;
  actorField?: string;
  csvDelimiter?: string;
}

type ValidationRowFields = Required<
  Pick<
    ValidationDatasetLoadOptions,
    "caseField" | "typeField" | "timestampField" | "outcomeField" | "sourceField" | "agentField" | "actorField"
  >
>;

const DEFAULT_FIELDS: ValidationRowFields = {
  caseField: "caseId",
  typeField: "type",
  timestampField: "ts",
  outcomeField: "outcome",
  sourceField: "source",
  agentField: "agentId",
  actorField: "actor"
};

const XES_DEFAULT_FIELDS: ValidationRowFields = {
  caseField: "concept:name",
  typeField: "concept:name",
  timestampField: "time:timestamp",
  outcomeField: "outcome",
  sourceField: "source",
  agentField: "agentId",
  actorField: "org:resource"
};

function arrayify<T>(value: T | T[] | undefined) {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function recordify(value: unknown) {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function resolveDatasetFormat(datasetPath: string, requested: ValidationDatasetLoadOptions["format"]): ValidationDatasetFormat {
  if (requested && requested !== "auto") {
    return requested;
  }

  if (datasetPath.endsWith(".jsonl")) {
    return "jsonl";
  }

  if (datasetPath.endsWith(".csv")) {
    return "csv";
  }

  if (datasetPath.endsWith(".xes")) {
    return "xes";
  }

  return "json";
}

function resolveRowFields(options?: ValidationDatasetLoadOptions, format?: ValidationDatasetFormat): ValidationRowFields {
  const defaults = format === "xes" ? XES_DEFAULT_FIELDS : DEFAULT_FIELDS;

  return {
    caseField: options?.caseField ?? defaults.caseField,
    typeField: options?.typeField ?? defaults.typeField,
    timestampField: options?.timestampField ?? defaults.timestampField,
    outcomeField: options?.outcomeField ?? defaults.outcomeField,
    sourceField: options?.sourceField ?? defaults.sourceField,
    agentField: options?.agentField ?? defaults.agentField,
    actorField: options?.actorField ?? defaults.actorField
  };
}

function inferOutcome(value: unknown): SherpaOutcome {
  if (typeof value !== "string") {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();

  if (
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done" ||
    normalized === "passed" ||
    normalized === "pass"
  ) {
    return "success";
  }

  if (
    normalized === "failure" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "blocked" ||
    normalized === "cancelled" ||
    normalized === "canceled"
  ) {
    return "failure";
  }

  return "unknown";
}

function sortCases(cases: ValidationCase[]) {
  return cases.map((validationCase) => ({
    ...validationCase,
    events: validationCase.events
      .map((event, index) => ({ event, index }))
      .sort((left, right) => {
        const leftTs = typeof left.event.ts === "string" ? Date.parse(left.event.ts) : Number.NaN;
        const rightTs = typeof right.event.ts === "string" ? Date.parse(right.event.ts) : Number.NaN;
        const leftHasTimestamp = Number.isFinite(leftTs);
        const rightHasTimestamp = Number.isFinite(rightTs);

        if (leftHasTimestamp && rightHasTimestamp && leftTs !== rightTs) {
          return leftTs - rightTs;
        }

        return left.index - right.index;
      })
      .map(({ event }) => event)
  }));
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

  return sortCases(
    [...grouped.entries()].map(([caseId, caseEvents]) => ({
      caseId,
      events: caseEvents
    }))
  );
}

function normalizeCaseEvents(validationCase: Record<string, unknown>) {
  const caseId = String(validationCase.caseId ?? "");
  if (!caseId) {
    throw new Error("Validation case is missing caseId");
  }

  const events = Array.isArray(validationCase.events) ? validationCase.events : [];
  const annotations = recordify(validationCase.annotations);
  const expectations = recordify(annotations?.expectations);

  return {
    caseId,
    events: events.map((event) => ({
      ...(event as SherpaEventInput),
      caseId
    })),
    ...(stringArray(validationCase.labels) ? { labels: stringArray(validationCase.labels) } : {}),
    ...(typeof validationCase.sourceTrace === "string" && validationCase.sourceTrace.trim().length > 0
      ? { sourceTrace: validationCase.sourceTrace.trim() }
      : {}),
    ...(annotations
      ? {
          annotations: {
            ...(typeof annotations.workflowClass === "string" && annotations.workflowClass.trim().length > 0
              ? { workflowClass: annotations.workflowClass.trim() }
              : {}),
            ...(Array.isArray(annotations.taskBoundaries)
              ? {
                  taskBoundaries: annotations.taskBoundaries
                    .map((entry) => recordify(entry))
                    .filter((entry): entry is Record<string, unknown> => entry !== null)
                    .flatMap((entry) => {
                      const startStep = typeof entry.startStep === "number" ? entry.startStep : Number.NaN;
                      if (!Number.isFinite(startStep)) {
                        return [];
                      }

                      return [
                        {
                          startStep,
                          ...(typeof entry.endStep === "number" && Number.isFinite(entry.endStep)
                            ? { endStep: entry.endStep }
                            : {}),
                          ...(typeof entry.title === "string" && entry.title.trim().length > 0
                            ? { title: entry.title.trim() }
                            : {}),
                          ...(typeof entry.reason === "string" && entry.reason.trim().length > 0
                            ? { reason: entry.reason.trim() }
                            : {})
                        }
                      ];
                    })
                }
              : {}),
            ...(Array.isArray(annotations.blockers)
              ? {
                  blockers: annotations.blockers
                    .map((entry) => recordify(entry))
                    .filter((entry): entry is Record<string, unknown> => entry !== null)
                    .flatMap((entry) => {
                      const step = typeof entry.step === "number" ? entry.step : Number.NaN;
                      const type = typeof entry.type === "string" ? entry.type.trim() : "";

                      if (!Number.isFinite(step) || type.length === 0) {
                        return [];
                      }

                      return [
                        {
                          step,
                          type,
                          ...(typeof entry.detail === "string" && entry.detail.trim().length > 0
                            ? { detail: entry.detail.trim() }
                            : {}),
                          ...(typeof entry.resolved === "boolean" ? { resolved: entry.resolved } : {})
                        }
                      ];
                    })
                }
              : {}),
            ...(expectations
              ? {
                  expectations: {
                    ...(Array.isArray(expectations.nextByStep)
                      ? {
                          nextByStep: expectations.nextByStep
                            .map((entry) => recordify(entry))
                            .filter((entry): entry is Record<string, unknown> => entry !== null)
                            .flatMap((entry) => {
                              const step = typeof entry.step === "number" ? entry.step : Number.NaN;
                              if (!Number.isFinite(step)) {
                                return [];
                              }

                              return [
                                {
                                  step,
                                  ...(stringArray(entry.expectedNext) ? { expectedNext: stringArray(entry.expectedNext) } : {}),
                                  ...(stringArray(entry.expectedRisks)
                                    ? { expectedRisks: stringArray(entry.expectedRisks) }
                                    : {}),
                                  ...(typeof entry.note === "string" && entry.note.trim().length > 0
                                    ? { note: entry.note.trim() }
                                    : {})
                                }
                              ];
                            })
                        }
                      : {}),
                    ...(typeof expectations.terminalOutcome === "string" &&
                    ["success", "failure", "unknown"].includes(expectations.terminalOutcome)
                      ? { terminalOutcome: expectations.terminalOutcome as SherpaOutcome }
                      : {})
                  }
                }
              : {}),
            ...(stringArray(annotations.notes) ? { notes: stringArray(annotations.notes) } : {})
          }
        }
      : {})
  } as ValidationCase;
}

function normalizeDelimitedRows(rows: Array<Record<string, unknown>>, fields: ValidationRowFields) {
  return rows.map((row, index) => {
    const caseId = String(row[fields.caseField] ?? "").trim();
    const type = String(row[fields.typeField] ?? "").trim();

    if (!caseId) {
      throw new Error(`Validation row ${index + 1} is missing ${fields.caseField}`);
    }

    if (!type) {
      throw new Error(`Validation row ${index + 1} is missing ${fields.typeField}`);
    }

    return {
      caseId,
      type,
      source: String(row[fields.sourceField] ?? "validation.import").trim() || "validation.import",
      ...(typeof row[fields.timestampField] === "string" && String(row[fields.timestampField]).trim().length > 0
        ? { ts: String(row[fields.timestampField]).trim() }
        : {}),
      ...(typeof row[fields.agentField] === "string" && String(row[fields.agentField]).trim().length > 0
        ? { agentId: String(row[fields.agentField]).trim() }
        : {}),
      ...(typeof row[fields.actorField] === "string" && String(row[fields.actorField]).trim().length > 0
        ? { actor: String(row[fields.actorField]).trim() }
        : {}),
      outcome: inferOutcome(row[fields.outcomeField])
    } satisfies SherpaEventInput;
  });
}

function materializeValidationCases(cases: ValidationCase[]) {
  const baseTimeMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

  return cases.map((validationCase, caseIndex) => ({
    ...validationCase,
    events: validationCase.events.map((event, eventIndex) => ({
      ...event,
      caseId: validationCase.caseId,
      eventId: event.eventId ?? `validation-${validationCase.caseId}-${eventIndex + 1}`,
      ts:
        event.ts ??
        new Date(baseTimeMs + caseIndex * 24 * 60 * 60 * 1000 + eventIndex * 60 * 1000).toISOString()
    }))
  }));
}

function xesAttributes(node: Record<string, unknown>) {
  const attributes: Record<string, string> = {};

  for (const tag of ["string", "date", "int", "float", "boolean"] as const) {
    for (const entry of arrayify(node[tag] as Array<Record<string, unknown>> | Record<string, unknown> | undefined)) {
      const key = typeof entry.key === "string" ? entry.key : null;
      const value = typeof entry.value === "string" ? entry.value : entry.value === undefined ? null : String(entry.value);

      if (key && value !== null) {
        attributes[key] = value;
      }
    }
  }

  return attributes;
}

function parseXesDataset(raw: string, fields: ValidationRowFields) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ""
  });
  const parsed = parser.parse(raw) as {
    log?: {
      trace?: Array<Record<string, unknown>> | Record<string, unknown>;
    };
  };

  const traces = arrayify(parsed.log?.trace);
  const events: SherpaEventInput[] = [];

  for (const trace of traces) {
    const traceAttributes = xesAttributes(trace);
    const caseId = traceAttributes[fields.caseField] ?? traceAttributes["concept:name"];

    if (!caseId) {
      throw new Error("XES trace is missing concept:name");
    }

    for (const eventNode of arrayify(trace.event as Array<Record<string, unknown>> | Record<string, unknown> | undefined)) {
      const eventAttributes = xesAttributes(eventNode);
      const type = eventAttributes[fields.typeField] ?? eventAttributes["concept:name"];

      if (!type) {
        continue;
      }

      const source =
        eventAttributes[fields.sourceField] ??
        traceAttributes[fields.sourceField] ??
        "validation.import";
      const outcomeSource =
        eventAttributes[fields.outcomeField] ??
        eventAttributes["lifecycle:transition"] ??
        type;

      events.push({
        caseId,
        type,
        source,
        ...(eventAttributes[fields.timestampField] ? { ts: eventAttributes[fields.timestampField] } : {}),
        ...(eventAttributes[fields.agentField] ? { agentId: eventAttributes[fields.agentField] } : {}),
        ...(eventAttributes[fields.actorField] ? { actor: eventAttributes[fields.actorField] } : {}),
        outcome: inferOutcome(outcomeSource)
      });
    }
  }

  return events;
}

export async function loadValidationDataset(
  datasetPath: string,
  options?: ValidationDatasetLoadOptions
): Promise<ValidationDataset & { format: ValidationDatasetFormat }> {
  const raw = await fs.readFile(datasetPath, "utf8");
  const format = resolveDatasetFormat(datasetPath, options?.format);
  const fields = resolveRowFields(options, format);

  if (format === "jsonl") {
    const events = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SherpaEventInput);

    return {
      name: path.basename(datasetPath, path.extname(datasetPath)),
      format,
      cases: groupEventsByCase(events)
    };
  }

  if (format === "csv") {
    const rows = parseCsv(raw, {
      columns: true,
      skip_empty_lines: true,
      delimiter: options?.csvDelimiter ?? ","
    }) as Array<Record<string, unknown>>;

    return {
      name: path.basename(datasetPath, path.extname(datasetPath)),
      format,
      cases: groupEventsByCase(normalizeDelimitedRows(rows, fields))
    };
  }

  if (format === "xes") {
    return {
      name: path.basename(datasetPath, path.extname(datasetPath)),
      format,
      cases: groupEventsByCase(parseXesDataset(raw, fields))
    };
  }

  const parsed = JSON.parse(raw) as
    | SherpaEventInput[]
    | {
        name?: string;
        description?: string;
        schemaVersion?: number;
        ontologyVersion?: string;
        split?: "train" | "dev" | "test";
        notes?: string[];
        cases?: Array<Record<string, unknown>>;
      };

  if (Array.isArray(parsed)) {
    return {
      name: path.basename(datasetPath, path.extname(datasetPath)),
      format,
      cases: groupEventsByCase(parsed)
    };
  }

  return {
    name: parsed.name ?? path.basename(datasetPath, path.extname(datasetPath)),
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(typeof parsed.schemaVersion === "number" ? { schemaVersion: parsed.schemaVersion } : {}),
    ...(typeof parsed.ontologyVersion === "string" && parsed.ontologyVersion.trim().length > 0
      ? { ontologyVersion: parsed.ontologyVersion.trim() }
      : {}),
    ...(parsed.split === "train" || parsed.split === "dev" || parsed.split === "test" ? { split: parsed.split } : {}),
    ...(stringArray(parsed.notes) ? { notes: stringArray(parsed.notes) } : {}),
    format,
    cases: sortCases(Array.isArray(parsed.cases) ? parsed.cases.map(normalizeCaseEvents) : [])
  } as ValidationDataset & { format: ValidationDatasetFormat };
}

export async function runValidationDataset(
  dataset: ValidationDataset,
  options?: {
    rootParent?: string;
    defaultOrder?: number;
    minOrder?: number;
    maxOrder?: number;
    minSupport?: number;
    stateStrategy?: SherpaStateStrategy;
    topK?: number;
    maxMisses?: number;
  }
): Promise<ValidationReport> {
  const topK = options?.topK ?? 3;
  const maxMisses = options?.maxMisses ?? 25;
  const stateStrategy = options?.stateStrategy ?? "family-procedure";
  const materializedCases = materializeValidationCases(dataset.cases);
  let evaluatedSteps = 0;
  let top1Hits = 0;
  let topKHits = 0;
  const misses: ValidationMiss[] = [];
  const eventStats = new Map<string, { occurrences: number; top1Hits: number; topKHits: number }>();
  const matchStats = new Map<string, { mode: ValidationMatchBreakdown["mode"]; matchedOrder: number; occurrences: number }>();
  const graphStateSamples: number[] = [];
  let matchedSteps = 0;
  let unmatchedSteps = 0;
  let candidateCountSum = 0;
  let totalSupportSum = 0;
  let topCandidateSupportSum = 0;
  let matchedOrderSum = 0;
  let riskEvaluatedSteps = 0;
  let expectedRiskCount = 0;
  let predictedRiskCount = 0;
  let truePositiveRiskCount = 0;
  let falsePositiveRiskCount = 0;
  let falseNegativeRiskCount = 0;
  const riskMisses: ValidationRiskMiss[] = [];
  const riskFalsePositives: ValidationRiskFalsePositive[] = [];

  for (const validationCase of materializedCases) {
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
        ...(options?.minSupport !== undefined ? { minSupport: options.minSupport } : {}),
        stateStrategy
      });

    try {
      const trainingEvents = materializedCases
        .filter((candidate) => candidate.caseId !== validationCase.caseId)
        .flatMap((candidate) => candidate.events);

      if (trainingEvents.length > 0) {
        await engine.ingestBatch(trainingEvents);
      } else {
        await engine.init();
      }

      const expectationByStep = new Map<number, ValidationStepExpectation>();
      for (const expectation of validationCase.annotations?.expectations?.nextByStep ?? []) {
        expectationByStep.set(expectation.step, expectation);
      }

      for (let index = 0; index < validationCase.events.length - 1; index += 1) {
        const current = validationCase.events[index];
        const expectedNext = validationCase.events[index + 1];
        if (!current || !expectedNext) {
          continue;
        }

        await engine.ingest(current as SherpaEventInput);

        const result = await engine.workflowNext(validationCase.caseId, topK);
        const predicted = result.candidates.map((candidate) => candidate.event);
        const top1 = predicted[0];
        const totalSupport = result.candidates.reduce((sum, candidate) => sum + candidate.support, 0);
        const topCandidateSupport = result.candidates[0]?.support ?? 0;
        const matchMode = result.match?.mode ?? "none";
        const matchedOrder = result.match?.matchedOrder ?? 0;
        const matchKey = `${matchMode}:${matchedOrder}`;
        const existingMatchStats = matchStats.get(matchKey) ?? {
          mode: matchMode,
          matchedOrder,
          occurrences: 0
        };
        const status = await engine.status();
        const expectation = expectationByStep.get(index + 1);
        const eventStat = eventStats.get(expectedNext.type) ?? {
          occurrences: 0,
          top1Hits: 0,
          topKHits: 0
        };

        evaluatedSteps += 1;
        eventStat.occurrences += 1;
        candidateCountSum += result.candidates.length;
        totalSupportSum += totalSupport;
        topCandidateSupportSum += topCandidateSupport;
        graphStateSamples.push(status.states);
        existingMatchStats.occurrences += 1;

        if (result.match) {
          matchedSteps += 1;
          matchedOrderSum += matchedOrder;
        } else {
          unmatchedSteps += 1;
        }

        if (top1 === expectedNext.type) {
          top1Hits += 1;
          eventStat.top1Hits += 1;
        }

        if (predicted.includes(expectedNext.type)) {
          topKHits += 1;
          eventStat.topKHits += 1;
        } else {
          if (misses.length < maxMisses) {
            misses.push({
              caseId: validationCase.caseId,
              step: index + 1,
              expected: expectedNext.type,
              predicted
            });
          }
        }

        eventStats.set(expectedNext.type, eventStat);
        matchStats.set(matchKey, existingMatchStats);

        const expectedRisks = expectation?.expectedRisks ?? [];
        if (expectedRisks.length > 0) {
          const riskResult = await engine.workflowRisks(validationCase.caseId, topK);
          const predictedRiskSet = new Set<string>();
          for (const risk of riskResult.risks) {
            predictedRiskSet.add(risk.branch);
            if (risk.semanticBranch) {
              predictedRiskSet.add(risk.semanticBranch);
            }
          }
          const predictedRisks = [...predictedRiskSet].sort();
          const expectedRiskSet = new Set(expectedRisks);
          const truePositives = expectedRisks.filter((risk) => predictedRiskSet.has(risk));
          const falsePositives = predictedRisks.filter((risk) => !expectedRiskSet.has(risk));
          const falseNegatives = expectedRisks.filter((risk) => !predictedRiskSet.has(risk));

          riskEvaluatedSteps += 1;
          expectedRiskCount += expectedRisks.length;
          predictedRiskCount += predictedRisks.length;
          truePositiveRiskCount += truePositives.length;
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
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  const datasetEvents = materializedCases.reduce((sum, validationCase) => sum + validationCase.events.length, 0);

  return {
    stateStrategy,
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
    eventBreakdown: [...eventStats.entries()]
      .map(([event, stats]) => ({
        event,
        occurrences: stats.occurrences,
        top1Hits: stats.top1Hits,
        topKHits: stats.topKHits,
        top1Accuracy: stats.occurrences === 0 ? 0 : stats.top1Hits / stats.occurrences,
        topKAccuracy: stats.occurrences === 0 ? 0 : stats.topKHits / stats.occurrences
      }))
      .sort((left, right) => {
        if (right.occurrences !== left.occurrences) {
          return right.occurrences - left.occurrences;
        }

        if (left.topKAccuracy !== right.topKAccuracy) {
          return left.topKAccuracy - right.topKAccuracy;
        }

        return left.event.localeCompare(right.event);
      }),
    misses,
    research: {
      support: {
        matchedSteps,
        unmatchedSteps,
        averageCandidateCount: evaluatedSteps === 0 ? 0 : Number((candidateCountSum / evaluatedSteps).toFixed(3)),
        averageTotalSupport: evaluatedSteps === 0 ? 0 : Number((totalSupportSum / evaluatedSteps).toFixed(3)),
        averageTopCandidateSupport: evaluatedSteps === 0 ? 0 : Number((topCandidateSupportSum / evaluatedSteps).toFixed(3)),
        averageMatchedOrder: matchedSteps === 0 ? 0 : Number((matchedOrderSum / matchedSteps).toFixed(3)),
        averageGraphStates:
          graphStateSamples.length === 0
            ? 0
            : Number((graphStateSamples.reduce((sum, count) => sum + count, 0) / graphStateSamples.length).toFixed(3)),
        minGraphStates: graphStateSamples.length === 0 ? 0 : Math.min(...graphStateSamples),
        maxGraphStates: graphStateSamples.length === 0 ? 0 : Math.max(...graphStateSamples)
      },
      matchBreakdown: [...matchStats.values()]
        .map((stats) => ({
          mode: stats.mode,
          matchedOrder: stats.matchedOrder,
          occurrences: stats.occurrences,
          share: evaluatedSteps === 0 ? 0 : Number((stats.occurrences / evaluatedSteps).toFixed(3))
        }))
        .sort((left, right) => {
          if (right.occurrences !== left.occurrences) {
            return right.occurrences - left.occurrences;
          }

          if (right.matchedOrder !== left.matchedOrder) {
            return right.matchedOrder - left.matchedOrder;
          }

          return left.mode.localeCompare(right.mode);
        }),
      risks: {
        evaluatedSteps: riskEvaluatedSteps,
        expectedRiskCount,
        predictedRiskCount,
        truePositiveCount: truePositiveRiskCount,
        falsePositiveCount: falsePositiveRiskCount,
        falseNegativeCount: falseNegativeRiskCount,
        precision:
          predictedRiskCount === 0 ? null : Number((truePositiveRiskCount / predictedRiskCount).toFixed(3)),
        recall: expectedRiskCount === 0 ? null : Number((truePositiveRiskCount / expectedRiskCount).toFixed(3)),
        misses: riskMisses,
        falsePositives: riskFalsePositives
      }
    }
  };
}

export async function runValidationComparison(
  dataset: ValidationDataset,
  options: {
    strategies: SherpaStateStrategy[];
    rootParent?: string;
    defaultOrder?: number;
    minOrder?: number;
    maxOrder?: number;
    minSupport?: number;
    topK?: number;
    maxMisses?: number;
  }
): Promise<ValidationComparisonReport> {
  const reports: ValidationReport[] = [];

  for (const strategy of options.strategies) {
    reports.push(
      await runValidationDataset(dataset, {
        ...options,
        stateStrategy: strategy
      })
    );
  }

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
    .filter((report) => report.research.risks.expectedRiskCount > 0)
    .sort((left, right) => {
      const leftRecall = left.research.risks.recall ?? -1;
      const rightRecall = right.research.risks.recall ?? -1;
      if (rightRecall !== leftRecall) {
        return rightRecall - leftRecall;
      }

      const leftPrecision = left.research.risks.precision ?? -1;
      const rightPrecision = right.research.risks.precision ?? -1;
      if (rightPrecision !== leftPrecision) {
        return rightPrecision - leftPrecision;
      }

      return left.missCount - right.missCount;
    })[0];
  const bestSupport = [...reports].sort((left, right) => {
    if (right.research.support.averageTotalSupport !== left.research.support.averageTotalSupport) {
      return right.research.support.averageTotalSupport - left.research.support.averageTotalSupport;
    }

    if (right.research.support.averageTopCandidateSupport !== left.research.support.averageTopCandidateSupport) {
      return right.research.support.averageTopCandidateSupport - left.research.support.averageTopCandidateSupport;
    }

    return left.research.support.averageGraphStates - right.research.support.averageGraphStates;
  })[0];

  return {
    strategies: reports,
    bestByAccuracy: best
      ? {
          stateStrategy: best.stateStrategy,
          nextTop1Accuracy: best.nextTop1Accuracy,
          nextTopKAccuracy: best.nextTopKAccuracy,
          missCount: best.missCount
        }
      : null,
    bestByRiskRecall: bestRisk
      ? {
          stateStrategy: bestRisk.stateStrategy,
          precision: bestRisk.research.risks.precision,
          recall: bestRisk.research.risks.recall,
          expectedRiskCount: bestRisk.research.risks.expectedRiskCount,
          predictedRiskCount: bestRisk.research.risks.predictedRiskCount
        }
      : null,
    bestBySupportDensity: bestSupport
      ? {
          stateStrategy: bestSupport.stateStrategy,
          averageTotalSupport: bestSupport.research.support.averageTotalSupport,
          averageTopCandidateSupport: bestSupport.research.support.averageTopCandidateSupport,
          averageGraphStates: bestSupport.research.support.averageGraphStates
        }
      : null
  };
}

export async function validateDatasetFile(
  datasetPath: string,
  options?: ValidationDatasetLoadOptions & {
    rootParent?: string;
    defaultOrder?: number;
    minOrder?: number;
    maxOrder?: number;
    minSupport?: number;
    stateStrategy?: SherpaStateStrategy;
    topK?: number;
    maxMisses?: number;
  }
) {
  const dataset = await loadValidationDataset(datasetPath, options);
  const report = await runValidationDataset(dataset, options);

  return {
    ...report,
    dataset: {
      ...report.dataset,
      path: datasetPath,
      format: dataset.format
    }
  };
}

export async function compareDatasetFile(
  datasetPath: string,
  options: ValidationDatasetLoadOptions & {
    strategies: SherpaStateStrategy[];
    rootParent?: string;
    defaultOrder?: number;
    minOrder?: number;
    maxOrder?: number;
    minSupport?: number;
    topK?: number;
    maxMisses?: number;
  }
) {
  const dataset = await loadValidationDataset(datasetPath, options);
  const report = await runValidationComparison(dataset, options);

  return {
    ...report,
    strategies: report.strategies.map((entry) => ({
      ...entry,
      dataset: {
        ...entry.dataset,
        path: datasetPath,
        format: dataset.format
      }
    }))
  };
}

export function assertValidationThresholds(report: ValidationReport, thresholds?: ValidationThresholds) {
  if (!thresholds) {
    return;
  }

  if (
    typeof thresholds.minTop1Accuracy === "number" &&
    report.nextTop1Accuracy < thresholds.minTop1Accuracy
  ) {
    throw new Error(
      `Validation top1 accuracy ${report.nextTop1Accuracy.toFixed(3)} is below required minimum ${thresholds.minTop1Accuracy.toFixed(3)}`
    );
  }

  if (
    typeof thresholds.minTopKAccuracy === "number" &&
    report.nextTopKAccuracy < thresholds.minTopKAccuracy
  ) {
    throw new Error(
      `Validation topK accuracy ${report.nextTopKAccuracy.toFixed(3)} is below required minimum ${thresholds.minTopKAccuracy.toFixed(3)}`
    );
  }

  if (typeof thresholds.maxMissCount === "number" && report.missCount > thresholds.maxMissCount) {
    throw new Error(
      `Validation miss count ${report.missCount} exceeds allowed maximum ${thresholds.maxMissCount}`
    );
  }
}
