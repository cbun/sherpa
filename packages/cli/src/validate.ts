import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseCsv } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";

import { SherpaEngine, type SherpaEventInput, type SherpaOutcome } from "@sherpa/core";

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

export interface ValidationEventBreakdown {
  event: string;
  occurrences: number;
  top1Hits: number;
  topKHits: number;
  top1Accuracy: number;
  topKAccuracy: number;
}

export interface ValidationThresholds {
  minTop1Accuracy?: number;
  minTopKAccuracy?: number;
  maxMissCount?: number;
}

export interface ValidationReport {
  dataset: {
    name: string;
    description: string | null;
    path: string;
    format: ValidationDatasetFormat;
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
    events: [...validationCase.events].sort((left, right) => {
      const leftTs = left.ts ?? "";
      const rightTs = right.ts ?? "";

      if (leftTs !== rightTs) {
        return leftTs.localeCompare(rightTs);
      }

      return String(left.type).localeCompare(String(right.type));
    })
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
  return {
    caseId,
    events: events.map((event) => ({
      ...(event as SherpaEventInput),
      caseId
    }))
  };
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
    format,
    cases: sortCases(Array.isArray(parsed.cases) ? parsed.cases.map(normalizeCaseEvents) : [])
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
    maxMisses?: number;
  }
): Promise<ValidationReport> {
  const topK = options?.topK ?? 3;
  const maxMisses = options?.maxMisses ?? 25;
  let evaluatedSteps = 0;
  let top1Hits = 0;
  let topKHits = 0;
  const misses: ValidationMiss[] = [];
  const eventStats = new Map<string, { occurrences: number; top1Hits: number; topKHits: number }>();

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
        const current = validationCase.events[index];
        const expectedNext = validationCase.events[index + 1];
        if (!current || !expectedNext) {
          continue;
        }

        await engine.ingest(current as SherpaEventInput);

        const result = await engine.workflowNext(validationCase.caseId, topK);
        const predicted = result.candidates.map((candidate) => candidate.event);
        const top1 = predicted[0];
        const eventStat = eventStats.get(expectedNext.type) ?? {
          occurrences: 0,
          top1Hits: 0,
          topKHits: 0
        };

        evaluatedSteps += 1;
        eventStat.occurrences += 1;

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
      path: "",
      format: "json"
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
    misses
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
