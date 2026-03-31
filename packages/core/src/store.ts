import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { ensureDir } from "./ledger.js";
import type { SherpaEvent } from "./types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function hasColumn(db: DatabaseSyncType, table: string, column: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function ensureColumn(db: DatabaseSyncType, table: string, column: string, definition: string) {
  if (hasColumn(db, table, column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateGraphSchema(db: DatabaseSyncType) {
  ensureColumn(db, "events", "actor", "TEXT NOT NULL DEFAULT 'agent'");
  ensureColumn(db, "events", "outcome", "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, "events", "labels_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "events", "entities_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "events", "metrics_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "events", "meta_json", "TEXT NOT NULL DEFAULT '{}'");

  ensureColumn(db, "cases", "agent_id", "TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(db, "cases", "event_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "cases", "first_seen_at", "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
  ensureColumn(db, "cases", "last_seen_at", "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
  ensureColumn(db, "cases", "terminal_outcome", "TEXT NOT NULL DEFAULT 'unknown'");

  ensureColumn(db, "state_edges", "success_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "state_edges", "failure_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "state_edges", "terminal_success_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "state_edges", "terminal_failure_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "state_edges", "terminal_unknown_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "state_edges", "total_duration_ms", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "state_edges", "min_duration_ms", "INTEGER");
  ensureColumn(db, "state_edges", "max_duration_ms", "INTEGER");
  ensureColumn(db, "state_edges", "last_seen_at", "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
}

export async function withGraphStore<T>(graphPath: string, handler: (db: DatabaseSyncType) => T): Promise<T> {
  await ensureDir(path.dirname(graphPath));
  await fs.mkdir(path.dirname(graphPath), { recursive: true });
  const db = new DatabaseSync(graphPath);

  try {
    db.exec(`
      PRAGMA busy_timeout = 3000;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        outcome TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        entities_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        meta_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        terminal_outcome TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS state_edges (
        order_n INTEGER NOT NULL,
        state_key TEXT NOT NULL,
        next_event TEXT NOT NULL,
        support INTEGER NOT NULL,
        success_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        terminal_success_count INTEGER NOT NULL,
        terminal_failure_count INTEGER NOT NULL,
        terminal_unknown_count INTEGER NOT NULL,
        total_duration_ms INTEGER NOT NULL,
        min_duration_ms INTEGER,
        max_duration_ms INTEGER,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (order_n, state_key, next_event)
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    migrateGraphSchema(db);

    return handler(db);
  } finally {
    db.close();
  }
}

export function resetDerivedTables(db: DatabaseSyncType) {
  db.exec(`
    DELETE FROM events;
    DELETE FROM cases;
    DELETE FROM state_edges;
  `);
}

export function insertEvents(db: DatabaseSyncType, events: SherpaEvent[]) {
  const statement = db.prepare(`
    INSERT INTO events (
      event_id, schema_version, agent_id, case_id, ts, source, type, actor, outcome,
      labels_json, entities_json, metrics_json, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const event of events) {
    statement.run(
      event.eventId,
      event.schemaVersion,
      event.agentId,
      event.caseId,
      event.ts,
      event.source,
      event.type,
      event.actor,
      event.outcome,
      json(event.labels),
      json(event.entities),
      json(event.metrics),
      json(event.meta)
    );
  }
}

export function insertCases(
  db: DatabaseSyncType,
  rows: Array<{
    caseId: string;
    agentId: string;
    eventCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    terminalOutcome: SherpaEvent["outcome"];
  }>
) {
  const statement = db.prepare(`
    INSERT INTO cases (case_id, agent_id, event_count, first_seen_at, last_seen_at, terminal_outcome)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    statement.run(row.caseId, row.agentId, row.eventCount, row.firstSeenAt, row.lastSeenAt, row.terminalOutcome);
  }
}

export function insertStateEdges(
  db: DatabaseSyncType,
  rows: Array<{
    orderN: number;
    stateKey: string;
    nextEvent: string;
    support: number;
    successCount: number;
    failureCount: number;
    terminalSuccessCount: number;
    terminalFailureCount: number;
    terminalUnknownCount: number;
    totalDurationMs: number;
    minDurationMs: number | null;
    maxDurationMs: number | null;
    lastSeenAt: string;
  }>
) {
  const statement = db.prepare(`
    INSERT INTO state_edges (
      order_n, state_key, next_event, support, success_count, failure_count,
      terminal_success_count, terminal_failure_count, terminal_unknown_count,
      total_duration_ms, min_duration_ms, max_duration_ms, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    statement.run(
      row.orderN,
      row.stateKey,
      row.nextEvent,
      row.support,
      row.successCount,
      row.failureCount,
      row.terminalSuccessCount,
      row.terminalFailureCount,
      row.terminalUnknownCount,
      row.totalDurationMs,
      row.minDurationMs,
      row.maxDurationMs,
      row.lastSeenAt
    );
  }
}

export function setMetadata(db: DatabaseSyncType, key: string, value: string) {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
