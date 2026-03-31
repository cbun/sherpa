import fs from "node:fs/promises";
import path from "node:path";

import { appendEvent, ensureDir, readLedger } from "./ledger.js";
import { buildDerivedRows, stateKeyFromEvents } from "./graph.js";
import { resolveSherpaPaths } from "./paths.js";
import { insertCases, insertEvents, insertStateEdges, resetDerivedTables, setMetadata, withGraphStore } from "./store.js";
import {
  type DoctorResult,
  type SherpaEngineOptions,
  type SherpaEvent,
  type SherpaEventInput,
  type WorkflowNextCandidate,
  type WorkflowNextResult,
  type WorkflowStateResult,
  type WorkflowStatusResult
} from "./types.js";

export class SherpaEngine {
  readonly rootDir: string;
  readonly defaultOrder: number;
  readonly minOrder: number;
  readonly maxOrder: number;
  readonly paths: ReturnType<typeof resolveSherpaPaths>;

  constructor(options: SherpaEngineOptions) {
    this.rootDir = options.rootDir;
    this.defaultOrder = options.defaultOrder ?? 3;
    this.minOrder = options.minOrder ?? 1;
    this.maxOrder = options.maxOrder ?? 5;
    this.paths = resolveSherpaPaths(options.rootDir);
  }

  async init() {
    await ensureDir(this.paths.rootDir);
    await ensureDir(this.paths.eventsDir);
    await ensureDir(path.dirname(this.paths.graphPath));

    await withGraphStore(this.paths.graphPath, () => undefined);
  }

  async ingest(eventInput: SherpaEventInput): Promise<SherpaEvent> {
    await this.init();
    const event = await appendEvent(this.paths.eventsDir, eventInput);
    await this.rebuild();
    return event;
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

      return {
        backend: "sherpa",
        healthy: true,
        events: Number(eventRow.count ?? 0),
        cases: Number(caseRow.count ?? 0),
        states: Number(stateRow.count ?? 0),
        lastUpdateAt: eventRow.last_ts ?? null,
        advisoryEnabled: false,
        ledgerPath: this.paths.eventsDir,
        graphPath: this.paths.graphPath
      };
    });
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
        .all(caseId, maxOrder) as Array<{
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
      }>;

      const ordered = recentEvents
        .reverse()
        .map((row) => ({
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
        }))
        .slice(-maxOrder);

      const state = ordered.map((event) => event.type);
      const stateKey = stateKeyFromEvents(state);
      const supportRow = db
        .prepare(
          `
            SELECT COALESCE(SUM(support), 0) as support
            FROM state_edges
            WHERE order_n = ? AND state_key = ?
          `
        )
        .get(state.length, stateKey) as { support: number };

      const support = Number(supportRow.support ?? 0);
      const confidence = support === 0 ? 0 : Number(Math.min(0.99, 0.45 + Math.log10(support + 1) / 3).toFixed(2));
      const matchedWorkflow =
        ordered
          .flatMap((event) => event.labels)
          .find((label) => label.startsWith("workflow:")) ?? null;

      return {
        caseId,
        state,
        matchedWorkflow,
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
      for (let order = Math.min(this.defaultOrder, state.state.length); order >= this.minOrder; order -= 1) {
        const currentState = state.state.slice(-order);
        const rows = db
          .prepare(
            `
              SELECT next_event, support, success_count, failure_count
              FROM state_edges
              WHERE order_n = ? AND state_key = ?
              ORDER BY support DESC, next_event ASC
            `
          )
          .all(order, stateKeyFromEvents(currentState)) as Array<{
          next_event: string;
          support: number;
          success_count: number;
          failure_count: number;
        }>;

        if (rows.length === 0) {
          continue;
        }

        const totalSupport = rows.reduce((sum, row) => sum + Number(row.support), 0);
        const candidates: WorkflowNextCandidate[] = rows.slice(0, limit).map((row) => ({
          event: row.next_event,
          probability: Number((Number(row.support) / totalSupport).toFixed(2)),
          support: Number(row.support),
          successRate:
            Number(row.success_count) + Number(row.failure_count) === 0
              ? null
              : Number(
                  (
                    Number(row.success_count) /
                    (Number(row.success_count) + Number(row.failure_count))
                  ).toFixed(2)
                ),
          matchedOrder: order,
          reason: `Matched ${order}-event suffix with ${row.support} prior observations`
        }));

        return {
          caseId,
          state: currentState,
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

  async doctor(): Promise<DoctorResult> {
    await this.init();

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

    return {
      healthy: checks.every((check) => check.ok),
      checks
    };
  }
}
