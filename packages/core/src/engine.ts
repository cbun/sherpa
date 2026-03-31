import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { appendEvent, appendEvents, ensureDir, readLedger } from "./ledger.js";
import { buildDerivedRows, stateKeyFromEvents } from "./graph.js";
import { resolveSherpaPaths } from "./paths.js";
import { insertCases, insertEvents, insertStateEdges, resetDerivedTables, setMetadata, withGraphStore } from "./store.js";
import {
  type AnalyticsReportOptions,
  type AnalyticsReportResult,
  type AnalyticsTransition,
  type DoctorResult,
  type ExportResult,
  type GcResult,
  type ImportResult,
  type SherpaEngineOptions,
  type SherpaEvent,
  type SherpaEventInput,
  type SherpaOutcome,
  type WorkflowNextCandidate,
  type WorkflowNextResult,
  type WorkflowRecallMode,
  type WorkflowRecallPath,
  type WorkflowRecallResult,
  type WorkflowRisk,
  type WorkflowRisksResult,
  type WorkflowStateResult,
  type WorkflowStatusResult,
  type TaxonomyReportOptions,
  type TaxonomyReportResult,
  type TaxonomyTypeSummary
} from "./types.js";

type StoredEventRow = {
  event_id: string;
  schema_version: number;
  agent_id: string;
  case_id: string;
  ts: string;
  source: string;
  type: string;
  actor: string;
  outcome: SherpaEvent["outcome"];
  labels_json: string;
  entities_json: string;
  metrics_json: string;
  meta_json: string;
};

type StateEdgeRow = {
  next_event: string;
  support: number;
  success_count: number;
  failure_count: number;
  terminal_success_count: number;
  terminal_failure_count: number;
  terminal_unknown_count: number;
  total_duration_ms: number;
};

type TaxonomyRow = {
  type: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  baseline_count: number;
  recent_count: number;
};

type AnalyticsEdgeRow = {
  order_n: number;
  state_key: string;
  next_event: string;
  support: number;
  terminal_success_count: number;
  terminal_failure_count: number;
  terminal_unknown_count: number;
  total_duration_ms: number;
  last_seen_at: string;
};

function deserializeEvent(row: StoredEventRow): SherpaEvent {
  return {
    eventId: row.event_id,
    schemaVersion: row.schema_version as 1,
    agentId: row.agent_id,
    caseId: row.case_id,
    ts: row.ts,
    source: row.source,
    type: row.type,
    actor: row.actor,
    outcome: row.outcome,
    labels: JSON.parse(row.labels_json) as string[],
    entities: JSON.parse(row.entities_json) as string[],
    metrics: JSON.parse(row.metrics_json) as Record<string, number>,
    meta: JSON.parse(row.meta_json) as Record<string, unknown>
  };
}

function confidenceFromSupport(support: number) {
  return support === 0 ? 0 : Number(Math.min(0.99, 0.45 + Math.log10(support + 1) / 3).toFixed(2));
}

function ageFromTimestamp(timestamp: string | null) {
  if (!timestamp) {
    return null;
  }

  const ageMs = Date.now() - Date.parse(timestamp);
  return Number.isFinite(ageMs) ? Math.max(0, ageMs) : null;
}

function eventualSuccessRate(row: StateEdgeRow) {
  const knownOutcomes = Number(row.terminal_success_count) + Number(row.terminal_failure_count);
  return knownOutcomes === 0 ? null : Number((Number(row.terminal_success_count) / knownOutcomes).toFixed(2));
}

function eventualFailureRate(row: StateEdgeRow) {
  const knownOutcomes = Number(row.terminal_success_count) + Number(row.terminal_failure_count);
  return knownOutcomes === 0 ? null : Number((Number(row.terminal_failure_count) / knownOutcomes).toFixed(2));
}

function branchScore(params: {
  row: StateEdgeRow;
  totalSupport: number;
  matchedOrder: number;
  defaultOrder: number;
}) {
  const probability = Number(params.row.support) / Math.max(1, params.totalSupport);
  const successRate = eventualSuccessRate(params.row);
  const failureRate = eventualFailureRate(params.row);
  const supportConfidence = Number(params.row.support) / (Number(params.row.support) + 2);
  const orderConfidence = params.matchedOrder / Math.max(1, params.defaultOrder);
  const qualityScore =
    0.55 +
    0.25 * (successRate ?? 0.5) +
    0.1 * supportConfidence +
    0.1 * orderConfidence -
    0.25 * (failureRate ?? 0);

  return Number((probability * Math.max(0, qualityScore)).toFixed(3));
}

function relativeRisk(rate: number, baselineRate: number) {
  if (rate <= 0) {
    return 0;
  }

  if (baselineRate <= 0) {
    return 99;
  }

  return Number((rate / baselineRate).toFixed(2));
}

function suggestIntervention(branch: string, kind: WorkflowRisk["kind"]) {
  if (branch.includes("attachment")) {
    return "verify required attachments before continuing";
  }

  if (branch.includes("approval")) {
    return "confirm approval owner and prerequisites before entering this branch";
  }

  if (kind === "stall") {
    return `set a checkpoint and fallback path before entering ${branch}`;
  }

  return `add validation before entering ${branch}`;
}

function riskConfidence(support: number, matchedOrder: number, defaultOrder: number) {
  const supportConfidence = support / (support + 2);
  const orderConfidence = matchedOrder / Math.max(1, defaultOrder);
  return Number(Math.min(0.99, 0.35 + 0.35 * supportConfidence + 0.3 * orderConfidence).toFixed(2));
}

function longestMatchingWindow(currentState: string[], sequence: string[], maxOrder: number) {
  const limit = Math.min(maxOrder, currentState.length, sequence.length);

  for (let order = limit; order >= 1; order -= 1) {
    const suffix = currentState.slice(-order);

    for (let endIndex = order - 1; endIndex < sequence.length; endIndex += 1) {
      const window = sequence.slice(endIndex - order + 1, endIndex + 1);

      if (window.length === order && window.every((event, index) => event === suffix[index])) {
        return {
          matchedOrder: order,
          continuation: sequence.slice(endIndex + 1)
        };
      }
    }
  }

  return null;
}

function recallConfidence(params: {
  matchedOrder: number;
  stateLength: number;
  continuationLength: number;
  outcome: SherpaOutcome;
}) {
  const overlap = params.matchedOrder / Math.max(1, params.stateLength);
  const continuationSignal = Math.min(1, params.continuationLength / 3);
  const outcomeSignal = params.outcome === "success" ? 1 : params.outcome === "failure" ? 0.75 : 0.5;

  return Number((0.45 * overlap + 0.3 * continuationSignal + 0.25 * outcomeSignal).toFixed(2));
}

function recallScore(params: {
  matchedOrder: number;
  stateLength: number;
  continuationLength: number;
  outcome: SherpaOutcome;
}) {
  const overlap = params.matchedOrder / Math.max(1, params.stateLength);
  const continuationSignal = Math.min(1, params.continuationLength / 4);
  const outcomeWeight = params.outcome === "success" ? 1 : params.outcome === "failure" ? 0.85 : 0.65;
  return Number((overlap * continuationSignal * outcomeWeight).toFixed(3));
}

function ratio(value: number, total: number) {
  if (total <= 0) {
    return 0;
  }

  return Number((value / total).toFixed(3));
}

function nullableRatio(value: number, total: number) {
  if (total <= 0) {
    return null;
  }

  return Number((value / total).toFixed(3));
}

function summarizeTaxonomyRow(
  row: TaxonomyRow,
  totals: {
    totalEvents: number;
    baselineEvents: number;
    recentEvents: number;
  },
  rareSupport: number
): TaxonomyTypeSummary {
  const baselineCount = Number(row.baseline_count);
  const recentCount = Number(row.recent_count);
  const count = Number(row.count);

  return {
    event: row.type,
    count,
    share: ratio(count, totals.totalEvents),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    baselineCount,
    baselineShare: nullableRatio(baselineCount, totals.baselineEvents),
    recentCount,
    recentShare: nullableRatio(recentCount, totals.recentEvents),
    isNewInRecentWindow: recentCount > 0 && baselineCount === 0,
    isRare: count <= rareSupport
  };
}

function summarizeAnalyticsEdge(row: AnalyticsEdgeRow): AnalyticsTransition {
  const support = Number(row.support);
  const knownOutcomes = Number(row.terminal_success_count) + Number(row.terminal_failure_count);

  return {
    order: Number(row.order_n),
    state: row.state_key.split(" -> "),
    nextEvent: row.next_event,
    support,
    successRate:
      knownOutcomes === 0 ? null : Number((Number(row.terminal_success_count) / knownOutcomes).toFixed(3)),
    failureRate:
      knownOutcomes === 0 ? null : Number((Number(row.terminal_failure_count) / knownOutcomes).toFixed(3)),
    stallRate: Number((Number(row.terminal_unknown_count) / Math.max(1, support)).toFixed(3)),
    meanTimeToNextMs: support === 0 ? null : Number((Number(row.total_duration_ms) / support).toFixed(0)),
    lastSeenAt: row.last_seen_at
  };
}

export class SherpaEngine {
  readonly rootDir: string;
  readonly defaultOrder: number;
  readonly minOrder: number;
  readonly maxOrder: number;
  readonly minSupport: number;
  readonly paths: ReturnType<typeof resolveSherpaPaths>;

  constructor(options: SherpaEngineOptions) {
    this.rootDir = options.rootDir;
    this.defaultOrder = options.defaultOrder ?? 3;
    this.minOrder = options.minOrder ?? 1;
    this.maxOrder = options.maxOrder ?? 5;
    this.minSupport = options.minSupport ?? 1;
    this.paths = resolveSherpaPaths(options.rootDir);
  }

  async init() {
    await ensureDir(this.paths.rootDir);
    await ensureDir(this.paths.eventsDir);
    await ensureDir(this.paths.cacheDir);
    await ensureDir(this.paths.tmpDir);
    await ensureDir(this.paths.exportDir);
    await ensureDir(path.dirname(this.paths.graphPath));

    await withGraphStore(this.paths.graphPath, () => undefined);
  }

  async ingest(eventInput: SherpaEventInput): Promise<SherpaEvent> {
    await this.init();
    const event = await appendEvent(this.paths.eventsDir, eventInput);
    await this.rebuild();
    return event;
  }

  async ingestBatch(eventInputs: SherpaEventInput[]): Promise<SherpaEvent[]> {
    if (eventInputs.length === 0) {
      return [];
    }

    await this.init();
    const events = await appendEvents(this.paths.eventsDir, eventInputs);
    await this.rebuild();
    return events;
  }

  async rebuild() {
    await this.init();
    const events = await readLedger(this.paths.eventsDir);
    const { caseRows, stateEdgeRows } = buildDerivedRows(events, this.maxOrder);

    await withGraphStore(this.paths.graphPath, (db) => {
      resetDerivedTables(db);
      insertEvents(db, events);
      insertCases(db, caseRows);
      insertStateEdges(db, stateEdgeRows);
      setMetadata(db, "defaultOrder", String(this.defaultOrder));
      setMetadata(db, "minOrder", String(this.minOrder));
      setMetadata(db, "maxOrder", String(this.maxOrder));
      setMetadata(db, "minSupport", String(this.minSupport));
      setMetadata(db, "lastRebuildAt", new Date().toISOString());
    });
  }

  async status(): Promise<WorkflowStatusResult> {
    await this.init();

    return withGraphStore(this.paths.graphPath, (db) => {
      const eventRow = db.prepare("SELECT COUNT(*) as count, MAX(ts) as last_ts FROM events").get() as {
        count: number;
        last_ts: string | null;
      };
      const caseRow = db.prepare("SELECT COUNT(*) as count FROM cases").get() as { count: number };
      const stateRow = db.prepare("SELECT COUNT(*) as count FROM state_edges").get() as { count: number };
      const rebuildRow = db.prepare("SELECT value FROM metadata WHERE key = 'lastRebuildAt'").get() as
        | { value: string }
        | undefined;
      const lastRebuildAt = rebuildRow?.value ?? null;

      return {
        backend: "sherpa",
        healthy: true,
        events: Number(eventRow.count ?? 0),
        cases: Number(caseRow.count ?? 0),
        states: Number(stateRow.count ?? 0),
        lastUpdateAt: eventRow.last_ts ?? null,
        lastRebuildAt,
        ledgerFreshness: {
          healthy: eventRow.last_ts !== null,
          latestEventAt: eventRow.last_ts ?? null,
          ageMs: ageFromTimestamp(eventRow.last_ts ?? null)
        },
        graphFreshness: {
          healthy: lastRebuildAt !== null,
          rebuiltAt: lastRebuildAt,
          ageMs: ageFromTimestamp(lastRebuildAt)
        },
        advisoryEnabled: false,
        config: {
          defaultOrder: this.defaultOrder,
          minOrder: this.minOrder,
          maxOrder: this.maxOrder,
          minSupport: this.minSupport
        },
        ledgerPath: this.paths.eventsDir,
        graphPath: this.paths.graphPath
      };
    });
  }

  async taxonomyReport(options: TaxonomyReportOptions = {}): Promise<TaxonomyReportResult> {
    await this.init();

    const recentDays = options.recentDays ?? 14;
    const rareSupport = options.rareSupport ?? 3;
    const limit = options.limit ?? 10;
    const generatedAt = options.asOf ?? new Date().toISOString();
    const recentWindowStart = new Date(Date.parse(generatedAt) - recentDays * 24 * 60 * 60 * 1000).toISOString();

    return withGraphStore(this.paths.graphPath, (db) => {
      const rows = db
        .prepare(
          `
            SELECT
              type,
              COUNT(*) as count,
              MIN(ts) as first_seen_at,
              MAX(ts) as last_seen_at,
              SUM(CASE WHEN ts < ? THEN 1 ELSE 0 END) as baseline_count,
              SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) as recent_count
            FROM events
            GROUP BY type
            ORDER BY count DESC, type ASC
          `
        )
        .all(recentWindowStart, recentWindowStart) as TaxonomyRow[];

      const totalEvents = rows.reduce((sum, row) => sum + Number(row.count), 0);
      const baselineEventCount = rows.reduce((sum, row) => sum + Number(row.baseline_count), 0);
      const recentEventCount = rows.reduce((sum, row) => sum + Number(row.recent_count), 0);
      const distinctTypes = rows.length;
      const baselineDistinctTypes = rows.filter((row) => Number(row.baseline_count) > 0).length;
      const recentDistinctTypes = rows.filter((row) => Number(row.recent_count) > 0).length;
      const summaries = rows.map((row) =>
        summarizeTaxonomyRow(
          row,
          {
            totalEvents,
            baselineEvents: baselineEventCount,
            recentEvents: recentEventCount
          },
          rareSupport
        )
      );

      let driftScore = 0;
      for (const summary of summaries) {
        driftScore += Math.abs((summary.recentShare ?? 0) - (summary.baselineShare ?? 0));
      }

      const rareTypes = summaries
        .filter((summary) => summary.isRare)
        .sort((left, right) => {
          if (left.count !== right.count) {
            return left.count - right.count;
          }

          if (right.recentCount !== left.recentCount) {
            return right.recentCount - left.recentCount;
          }

          return left.event.localeCompare(right.event);
        })
        .slice(0, limit);

      const recentNewTypes = summaries
        .filter((summary) => summary.isNewInRecentWindow)
        .sort((left, right) => {
          if (right.recentCount !== left.recentCount) {
            return right.recentCount - left.recentCount;
          }

          return left.event.localeCompare(right.event);
        })
        .slice(0, limit);

      return {
        generatedAt,
        totalEvents,
        distinctTypes,
        rareSupport,
        topTypes: summaries.slice(0, limit),
        rareTypes,
        recentNewTypes,
        drift: {
          recentWindowDays: recentDays,
          recentWindowStart,
          baselineEventCount,
          baselineDistinctTypes,
          recentEventCount,
          recentDistinctTypes,
          newTypeCount: summaries.filter((summary) => summary.isNewInRecentWindow).length,
          newTypeShare: ratio(
            summaries.filter((summary) => summary.isNewInRecentWindow).reduce((sum, summary) => sum + summary.recentCount, 0),
            recentEventCount
          ),
          rareTypeCount: summaries.filter((summary) => summary.isRare).length,
          rareEventShare: ratio(
            summaries.filter((summary) => summary.isRare).reduce((sum, summary) => sum + summary.count, 0),
            totalEvents
          ),
          score: Number((driftScore / 2).toFixed(3))
        }
      };
    });
  }

  async analyticsReport(options: AnalyticsReportOptions = {}): Promise<AnalyticsReportResult> {
    await this.init();

    const limit = options.limit ?? 10;
    const generatedAt = options.asOf ?? new Date().toISOString();

    return withGraphStore(this.paths.graphPath, (db) => {
      const caseRows = db
        .prepare(
          `
            SELECT terminal_outcome, COUNT(*) as count
            FROM cases
            GROUP BY terminal_outcome
          `
        )
        .all() as Array<{ terminal_outcome: SherpaEvent["outcome"]; count: number }>;

      const totalCases = caseRows.reduce((sum, row) => sum + Number(row.count), 0);
      const successCases = Number(caseRows.find((row) => row.terminal_outcome === "success")?.count ?? 0);
      const failureCases = Number(caseRows.find((row) => row.terminal_outcome === "failure")?.count ?? 0);
      const unknownCases = Number(caseRows.find((row) => row.terminal_outcome === "unknown")?.count ?? 0);

      const edges = db
        .prepare(
          `
            SELECT
              order_n,
              state_key,
              next_event,
              support,
              terminal_success_count,
              terminal_failure_count,
              terminal_unknown_count,
              total_duration_ms,
              last_seen_at
            FROM state_edges
          `
        )
        .all() as AnalyticsEdgeRow[];

      const transitions = edges.map(summarizeAnalyticsEdge);

      return {
        generatedAt,
        cases: {
          total: totalCases,
          success: successCases,
          failure: failureCases,
          unknown: unknownCases,
          successRate: ratio(successCases, totalCases),
          failureRate: ratio(failureCases, totalCases)
        },
        hotTransitions: [...transitions]
          .sort((left, right) => {
            if (right.support !== left.support) {
              return right.support - left.support;
            }

            if (right.order !== left.order) {
              return right.order - left.order;
            }

            return left.nextEvent.localeCompare(right.nextEvent);
          })
          .slice(0, limit),
        failureBranches: transitions
          .filter((transition) => (transition.failureRate ?? 0) > 0)
          .sort((left, right) => {
            if ((right.failureRate ?? 0) !== (left.failureRate ?? 0)) {
              return (right.failureRate ?? 0) - (left.failureRate ?? 0);
            }

            if (right.support !== left.support) {
              return right.support - left.support;
            }

            return left.nextEvent.localeCompare(right.nextEvent);
          })
          .slice(0, limit),
        stallBranches: transitions
          .filter((transition) => (transition.stallRate ?? 0) > 0)
          .sort((left, right) => {
            if ((right.stallRate ?? 0) !== (left.stallRate ?? 0)) {
              return (right.stallRate ?? 0) - (left.stallRate ?? 0);
            }

            if (right.support !== left.support) {
              return right.support - left.support;
            }

            return left.nextEvent.localeCompare(right.nextEvent);
          })
          .slice(0, limit)
      };
    });
  }

  private readMatchedEdges(db: DatabaseSyncType, state: string[]) {
    for (let order = Math.min(this.defaultOrder, state.length); order >= this.minOrder; order -= 1) {
      const currentState = state.slice(-order);
      const rows = db
        .prepare(
          `
            SELECT next_event, support, success_count, failure_count,
                   terminal_success_count, terminal_failure_count, terminal_unknown_count,
                   total_duration_ms
            FROM state_edges
            WHERE order_n = ? AND state_key = ?
            ORDER BY support DESC, next_event ASC
          `
        )
        .all(order, stateKeyFromEvents(currentState)) as StateEdgeRow[];

      if (rows.length > 0) {
        const totalSupport = rows.reduce((sum, row) => sum + Number(row.support), 0);

        if (totalSupport < this.minSupport) {
          continue;
        }

        return {
          matchedOrder: order,
          currentState,
          rows,
          totalSupport
        };
      }
    }

    return null;
  }

  async workflowState(caseId: string, maxOrder = this.defaultOrder): Promise<WorkflowStateResult> {
    await this.init();

    return withGraphStore(this.paths.graphPath, (db) => {
      const recentEvents = db
        .prepare(
          `
            SELECT event_id, schema_version, agent_id, case_id, ts, source, type, actor, outcome,
                   labels_json, entities_json, metrics_json, meta_json
            FROM events
            WHERE case_id = ?
            ORDER BY ts DESC, event_id DESC
            LIMIT ?
          `
        )
        .all(caseId, maxOrder) as StoredEventRow[];

      const ordered = recentEvents.reverse().map(deserializeEvent).slice(-maxOrder);

      const state = ordered.map((event) => event.type);
      const supportQuery = db.prepare(
        `
          SELECT COALESCE(SUM(support), 0) as support
          FROM state_edges
          WHERE order_n = ? AND state_key = ?
        `
      );
      const matchedWorkflow =
        ordered
          .flatMap((event) => event.labels)
          .find((label) => label.startsWith("workflow:")) ?? null;
      const match = this.readMatchedEdges(db, state);
      const matchedOrder = match?.matchedOrder ?? state.length;
      const matchedState = match?.currentState ?? state;
      const matchedStateKey = stateKeyFromEvents(matchedState);
      const supportRow = supportQuery.get(matchedState.length, matchedStateKey) as { support: number };
      const support = Number(supportRow.support ?? 0);
      const confidence = confidenceFromSupport(support);

      return {
        caseId,
        state: matchedState,
        matchedWorkflow,
        matchedOrder,
        confidence,
        support,
        recentEvents: ordered
      };
    });
  }

  async workflowNext(caseId: string, limit = 5): Promise<WorkflowNextResult> {
    await this.init();
    const state = await this.workflowState(caseId, this.defaultOrder);

    return withGraphStore(this.paths.graphPath, (db) => {
      const match = this.readMatchedEdges(db, state.state);

      if (match) {
        const candidates: WorkflowNextCandidate[] = match.rows
          .map((row) => {
            const successRate = eventualSuccessRate(row);
            const failureRate = eventualFailureRate(row);
            const score = branchScore({
              row,
              totalSupport: match.totalSupport,
              matchedOrder: match.matchedOrder,
              defaultOrder: this.defaultOrder
            });

            return {
              event: row.next_event,
              probability: Number((Number(row.support) / match.totalSupport).toFixed(2)),
              support: Number(row.support),
              successRate,
              failureRate,
              meanTimeToNextMs:
                Number(row.support) === 0 ? null : Number((Number(row.total_duration_ms) / Number(row.support)).toFixed(0)),
              matchedOrder: match.matchedOrder,
              score,
              reason: `Matched ${match.matchedOrder}-event suffix with ${row.support} prior observations`
            };
          })
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }

            if (right.probability !== left.probability) {
              return right.probability - left.probability;
            }

            if ((right.successRate ?? -1) !== (left.successRate ?? -1)) {
              return (right.successRate ?? -1) - (left.successRate ?? -1);
            }

            return right.support - left.support;
          })
          .slice(0, limit);

        return {
          caseId,
          state: match.currentState,
          candidates
        };
      }

      return {
        caseId,
        state: state.state,
        candidates: []
      };
    });
  }

  async workflowRisks(caseId: string, limit = 3): Promise<WorkflowRisksResult> {
    await this.init();
    const state = await this.workflowState(caseId, this.defaultOrder);

    return withGraphStore(this.paths.graphPath, (db) => {
      const match = this.readMatchedEdges(db, state.state);

      if (!match) {
        return {
          caseId,
          state: state.state,
          risks: []
        };
      }

      const baselineFailureRate =
        match.rows.reduce((sum, row) => sum + Number(row.terminal_failure_count), 0) / Math.max(1, match.totalSupport);
      const baselineStallRate =
        match.rows.reduce((sum, row) => sum + Number(row.terminal_unknown_count), 0) / Math.max(1, match.totalSupport);

      const risks: WorkflowRisk[] = [];

      for (const row of match.rows) {
        const branchProbability = Number((Number(row.support) / match.totalSupport).toFixed(2));
        const failureRate = Number(row.terminal_failure_count) / Math.max(1, Number(row.support));
        const stallRate = Number(row.terminal_unknown_count) / Math.max(1, Number(row.support));
        const confidence = riskConfidence(Number(row.support), match.matchedOrder, this.defaultOrder);

        if (Number(row.terminal_failure_count) > 0 && failureRate > baselineFailureRate) {
          const branchRelativeRisk = relativeRisk(failureRate, baselineFailureRate);
          risks.push({
            branch: row.next_event,
            kind: "failure",
            probability: branchProbability,
            relativeRisk: branchRelativeRisk,
            support: Number(row.support),
            matchedOrder: match.matchedOrder,
            confidence,
            score: Number((branchProbability * branchRelativeRisk * confidence).toFixed(3)),
            suggestedIntervention: suggestIntervention(row.next_event, "failure")
          });
        }

        if (Number(row.terminal_unknown_count) > 0 && stallRate > baselineStallRate) {
          const branchRelativeRisk = relativeRisk(stallRate, baselineStallRate);
          risks.push({
            branch: row.next_event,
            kind: "stall",
            probability: branchProbability,
            relativeRisk: branchRelativeRisk,
            support: Number(row.support),
            matchedOrder: match.matchedOrder,
            confidence,
            score: Number((branchProbability * branchRelativeRisk * confidence).toFixed(3)),
            suggestedIntervention: suggestIntervention(row.next_event, "stall")
          });
        }
      }

      return {
        caseId,
        state: match.currentState,
        risks: risks
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }

            if (right.relativeRisk !== left.relativeRisk) {
              return right.relativeRisk - left.relativeRisk;
            }

            if (right.probability !== left.probability) {
              return right.probability - left.probability;
            }

            return right.support - left.support;
          })
          .slice(0, limit)
      };
    });
  }

  async workflowRecall(caseId: string, mode: WorkflowRecallMode = "successful", limit = 3): Promise<WorkflowRecallResult> {
    await this.init();
    const currentState = await this.workflowState(caseId, this.defaultOrder);

    if (currentState.state.length === 0) {
      return {
        caseId,
        state: [],
        mode,
        paths: []
      };
    }

    return withGraphStore(this.paths.graphPath, (db) => {
      const candidateCases = db
        .prepare(
          `
            SELECT case_id, terminal_outcome, event_count, last_seen_at
            FROM cases
            WHERE case_id != ?
            ORDER BY last_seen_at DESC, case_id ASC
          `
        )
        .all(caseId) as Array<{
          case_id: string;
          terminal_outcome: SherpaEvent["outcome"];
          event_count: number;
          last_seen_at: string;
        }>;

      const paths: WorkflowRecallPath[] = [];

      for (const candidate of candidateCases) {
        if (mode === "successful" && candidate.terminal_outcome !== "success") {
          continue;
        }

        if (mode === "failed" && candidate.terminal_outcome !== "failure") {
          continue;
        }

        const sequence = db
          .prepare(
            `
              SELECT type
              FROM events
              WHERE case_id = ?
              ORDER BY ts ASC, event_id ASC
            `
          )
          .all(candidate.case_id) as Array<{ type: string }>;

        const match = longestMatchingWindow(
          currentState.state,
          sequence.map((row) => row.type),
          this.defaultOrder
        );

        if (!match || match.continuation.length === 0) {
          continue;
        }

        paths.push({
          caseId: candidate.case_id,
          distance: Number((1 - match.matchedOrder / currentState.state.length).toFixed(2)),
          outcome: candidate.terminal_outcome,
          matchedOrder: match.matchedOrder,
          confidence: recallConfidence({
            matchedOrder: match.matchedOrder,
            stateLength: currentState.state.length,
            continuationLength: match.continuation.length,
            outcome: candidate.terminal_outcome
          }),
          score: recallScore({
            matchedOrder: match.matchedOrder,
            stateLength: currentState.state.length,
            continuationLength: match.continuation.length,
            outcome: candidate.terminal_outcome
          }),
          continuation: match.continuation.slice(0, 8)
        });
      }

      return {
        caseId,
        state: currentState.state,
        mode,
        paths: paths
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }

            if (right.confidence !== left.confidence) {
              return right.confidence - left.confidence;
            }

            if (right.matchedOrder !== left.matchedOrder) {
              return right.matchedOrder - left.matchedOrder;
            }

            if (left.distance !== right.distance) {
              return left.distance - right.distance;
            }

            return left.caseId.localeCompare(right.caseId);
          })
          .slice(0, limit)
      };
    });
  }

  async doctor(): Promise<DoctorResult> {
    await this.init();
    const status = await this.status();

    const checks: DoctorResult["checks"] = [];

    try {
      await fs.access(this.paths.rootDir);
      checks.push({ name: "rootDir", ok: true, details: this.paths.rootDir });
    } catch {
      checks.push({ name: "rootDir", ok: false, details: "root directory is not accessible" });
    }

    try {
      await fs.access(this.paths.eventsDir);
      checks.push({ name: "eventsDir", ok: true, details: this.paths.eventsDir });
    } catch {
      checks.push({ name: "eventsDir", ok: false, details: "events directory is not accessible" });
    }

    try {
      await withGraphStore(this.paths.graphPath, (db) => {
        db.prepare("SELECT 1").get();
      });
      checks.push({ name: "graphStore", ok: true, details: this.paths.graphPath });
    } catch (error) {
      checks.push({
        name: "graphStore",
        ok: false,
        details: error instanceof Error ? error.message : "graph store probe failed"
      });
    }

    checks.push({
      name: "ledgerFreshness",
      ok: status.ledgerFreshness.healthy,
      details:
        status.ledgerFreshness.latestEventAt === null
          ? "no ledger events found"
          : `latest event at ${status.ledgerFreshness.latestEventAt}`
    });

    checks.push({
      name: "graphFreshness",
      ok: status.graphFreshness.healthy,
      details:
        status.graphFreshness.rebuiltAt === null
          ? "graph has not been rebuilt yet"
          : `last rebuilt at ${status.graphFreshness.rebuiltAt}`
    });

    return {
      healthy: checks.every((check) => check.ok),
      checks
    };
  }

  async exportSnapshot(): Promise<ExportResult> {
    await this.init();
    const exportedAt = new Date().toISOString();
    const fileName = `${exportedAt.replaceAll(":", "-")}.json`;
    const exportPath = path.join(this.paths.exportDir, fileName);

    const snapshot = await withGraphStore(this.paths.graphPath, (db) => {
      const cases = db
        .prepare(
          `
            SELECT case_id, agent_id, event_count, first_seen_at, last_seen_at, terminal_outcome
            FROM cases
            ORDER BY last_seen_at DESC, case_id ASC
          `
        )
        .all() as Array<{
        case_id: string;
        agent_id: string;
        event_count: number;
        first_seen_at: string;
        last_seen_at: string;
        terminal_outcome: SherpaEvent["outcome"];
      }>;

      const stateEdges = db
        .prepare(
          `
            SELECT order_n, state_key, next_event, support, success_count, failure_count,
                   terminal_success_count, terminal_failure_count, terminal_unknown_count,
                   total_duration_ms, min_duration_ms, max_duration_ms, last_seen_at
            FROM state_edges
            ORDER BY support DESC, order_n DESC, state_key ASC, next_event ASC
          `
        )
        .all();

      const events = (
        db
          .prepare("SELECT event_id, schema_version, agent_id, case_id, ts, source, type, actor, outcome, labels_json, entities_json, metrics_json, meta_json FROM events ORDER BY ts ASC, event_id ASC")
          .all() as StoredEventRow[]
      ).map(deserializeEvent);

      return {
        exportedAt,
        status: null as unknown,
        events,
        cases,
        stateEdges
      };
    });

    const status = await this.status();
    snapshot.status = status;

    await fs.writeFile(exportPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    return {
      exportPath,
      exportedAt,
      eventCount: status.events,
      caseCount: status.cases,
      stateCount: status.states
    };
  }

  async importSnapshot(snapshotPath: string): Promise<ImportResult> {
    await this.init();

    const importedAt = new Date().toISOString();
    const raw = await fs.readFile(snapshotPath, "utf8");
    const snapshot = JSON.parse(raw) as {
      exportedAt?: string;
      events?: SherpaEvent[];
    };

    const fromExportedAt = typeof snapshot.exportedAt === "string" ? snapshot.exportedAt : null;
    const snapshotEvents = Array.isArray(snapshot.events) ? snapshot.events : [];

    if (snapshotEvents.length === 0) {
      return {
        importedAt,
        eventCount: 0,
        caseCount: 0,
        fromExportedAt
      };
    }

    const ledgerEvents = await readLedger(this.paths.eventsDir);
    const existingIds = new Set(ledgerEvents.map((event) => event.eventId));
    const newEvents = snapshotEvents.filter((event) => !existingIds.has(event.eventId));

    if (newEvents.length > 0) {
      await appendEvents(this.paths.eventsDir, newEvents);
    }

    await this.rebuild();

    const status = await this.status();

    return {
      importedAt,
      eventCount: status.events,
      caseCount: status.cases,
      fromExportedAt
    };
  }

  async gc(): Promise<GcResult> {
    await this.init();

    const removedTmpFiles = await this.removeAllFiles(this.paths.tmpDir);
    const removedExportFiles = await this.pruneOldFiles(this.paths.exportDir, 10);

    await withGraphStore(this.paths.graphPath, (db) => {
      db.exec("VACUUM;");
    });

    return {
      vacuumed: true,
      removedTmpFiles,
      removedExportFiles
    };
  }

  private async removeAllFiles(dirPath: string) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      let removed = 0;

      for (const entry of entries) {
        const target = path.join(dirPath, entry.name);
        await fs.rm(target, { recursive: true, force: true });
        removed += 1;
      }

      return removed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }

      throw error;
    }
  }

  private async pruneOldFiles(dirPath: string, keepLatest: number) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            const target = path.join(dirPath, entry.name);
            const stat = await fs.stat(target);
            return {
              path: target,
              mtimeMs: stat.mtimeMs
            };
          })
      );

      const stale = files
        .sort((left, right) => right.mtimeMs - left.mtimeMs)
        .slice(keepLatest);

      await Promise.all(stale.map((file) => fs.rm(file.path, { force: true })));

      return stale.length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }

      throw error;
    }
  }
}
