import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SherpaEngine } from "./engine.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

const tempDirs: string[] = [];

async function createEngine(options?: Omit<Partial<ConstructorParameters<typeof SherpaEngine>[0]>, "rootDir">) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-core-"));
  tempDirs.push(rootDir);
  return new SherpaEngine({ rootDir, defaultOrder: 3, maxOrder: 4, ...options });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SherpaEngine", () => {
  it("rebuilds graph state and returns next-step, risk, and recall retrieval", async () => {
    const engine = await createEngine();

    const events = [
      {
        caseId: "case-1",
        ts: "2026-03-30T10:00:00.000Z",
        source: "tool.docs",
        type: "docs.requested",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-1",
        ts: "2026-03-30T10:01:00.000Z",
        source: "tool.docs",
        type: "docs.received",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-1",
        ts: "2026-03-30T10:02:00.000Z",
        source: "tool.review",
        type: "review.started",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-1",
        ts: "2026-03-30T10:03:00.000Z",
        source: "tool.review",
        type: "approval.needed",
        outcome: "unknown" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-1",
        ts: "2026-03-30T10:04:00.000Z",
        source: "tool.review",
        type: "approval.granted",
        outcome: "unknown" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-1",
        ts: "2026-03-30T10:05:00.000Z",
        source: "tool.report",
        type: "report.sent",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-2",
        ts: "2026-03-30T11:00:00.000Z",
        source: "tool.docs",
        type: "docs.requested",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-2",
        ts: "2026-03-30T11:01:00.000Z",
        source: "tool.docs",
        type: "docs.received",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-2",
        ts: "2026-03-30T11:02:00.000Z",
        source: "tool.review",
        type: "review.started",
        outcome: "unknown" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-2",
        ts: "2026-03-30T11:03:00.000Z",
        source: "tool.review",
        type: "missing.attachment",
        outcome: "unknown" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-2",
        ts: "2026-03-30T11:04:00.000Z",
        source: "tool.review",
        type: "review.failed",
        outcome: "failure" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-3",
        ts: "2026-03-30T12:00:00.000Z",
        source: "tool.docs",
        type: "docs.requested",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-3",
        ts: "2026-03-30T12:01:00.000Z",
        source: "tool.docs",
        type: "docs.received",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-3",
        ts: "2026-03-30T12:02:00.000Z",
        source: "tool.review",
        type: "review.started",
        outcome: "unknown" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-3",
        ts: "2026-03-30T12:03:00.000Z",
        source: "tool.review",
        type: "waiting.on.customer",
        outcome: "unknown" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-current",
        ts: "2026-03-30T13:00:00.000Z",
        source: "tool.docs",
        type: "docs.requested",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-current",
        ts: "2026-03-30T13:01:00.000Z",
        source: "tool.docs",
        type: "docs.received",
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      },
      {
        caseId: "case-current",
        ts: "2026-03-30T13:02:00.000Z",
        source: "tool.review",
        type: "review.started",
        outcome: "unknown" as const,
        labels: ["workflow:vendor-review"]
      }
    ];

    for (const event of events) {
      await engine.ingest(event);
    }

    const status = await engine.status();
    expect(status.events).toBe(18);
    expect(status.cases).toBe(4);

    const state = await engine.workflowState("case-current");
    expect(state.state).toEqual(["docs.requested", "docs.received", "review.started"]);
    expect(state.matchedWorkflow).toBe("workflow:vendor-review");
    expect(state.matchedOrder).toBe(3);
    expect(state.support).toBe(3);

    const next = await engine.workflowNext("case-current");
    expect(next.candidates).toHaveLength(3);
    expect(next.candidates[0]).toMatchObject({
      event: "approval.needed",
      probability: 0.33,
      support: 1,
      successRate: 1,
      failureRate: 0,
      matchedOrder: 3,
      meanTimeToNextMs: 60000,
      score: 0.311
    });
    expect(next.candidates.at(-1)).toMatchObject({
      event: "missing.attachment",
      failureRate: 1
    });

    const risks = await engine.workflowRisks("case-current");
    expect(risks.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: "missing.attachment",
          kind: "failure",
          matchedOrder: 3,
          confidence: 0.77,
          score: 0.762
        }),
        expect.objectContaining({
          branch: "waiting.on.customer",
          kind: "stall",
          matchedOrder: 3,
          confidence: 0.77,
          score: 0.762
        })
      ])
    );

    const recall = await engine.workflowRecall("case-current", "successful");
    expect(recall.paths[0]).toMatchObject({
      caseId: "case-1",
      outcome: "success",
      matchedOrder: 3,
      confidence: 1,
      score: 0.75,
      continuation: ["approval.needed", "approval.granted", "report.sent"]
    });

    const failedRecall = await engine.workflowRecall("case-current", "failed");
    expect(failedRecall.paths[0]).toMatchObject({
      caseId: "case-2",
      outcome: "failure",
      matchedOrder: 3,
      confidence: 0.84,
      score: 0.425,
      continuation: ["missing.attachment", "review.failed"]
    });
  });

  it("falls back to a shorter suffix when higher-order support is below the threshold", async () => {
    const engine = await createEngine({ minSupport: 2 });

    const events = [
      {
        caseId: "case-1",
        ts: "2026-03-30T10:00:00.000Z",
        source: "tool.docs",
        type: "docs.requested",
        outcome: "success" as const
      },
      {
        caseId: "case-1",
        ts: "2026-03-30T10:01:00.000Z",
        source: "tool.docs",
        type: "docs.received",
        outcome: "success" as const
      },
      {
        caseId: "case-1",
        ts: "2026-03-30T10:02:00.000Z",
        source: "tool.review",
        type: "review.started",
        outcome: "unknown" as const
      },
      {
        caseId: "case-1",
        ts: "2026-03-30T10:03:00.000Z",
        source: "tool.review",
        type: "approval.needed",
        outcome: "success" as const
      },
      {
        caseId: "case-2",
        ts: "2026-03-30T11:00:00.000Z",
        source: "tool.review",
        type: "docs.received",
        outcome: "success" as const
      },
      {
        caseId: "case-2",
        ts: "2026-03-30T11:01:00.000Z",
        source: "tool.review",
        type: "review.started",
        outcome: "unknown" as const
      },
      {
        caseId: "case-2",
        ts: "2026-03-30T11:02:00.000Z",
        source: "tool.review",
        type: "approval.needed",
        outcome: "success" as const
      },
      {
        caseId: "case-current",
        ts: "2026-03-30T12:00:00.000Z",
        source: "tool.docs",
        type: "docs.requested",
        outcome: "success" as const
      },
      {
        caseId: "case-current",
        ts: "2026-03-30T12:01:00.000Z",
        source: "tool.docs",
        type: "docs.received",
        outcome: "success" as const
      },
      {
        caseId: "case-current",
        ts: "2026-03-30T12:02:00.000Z",
        source: "tool.review",
        type: "review.started",
        outcome: "unknown" as const
      }
    ];

    for (const event of events) {
      await engine.ingest(event);
    }

    const state = await engine.workflowState("case-current");
    expect(state.matchedOrder).toBe(2);
    expect(state.state).toEqual(["docs.received", "review.started"]);

    const next = await engine.workflowNext("case-current");
    expect(next.state).toEqual(["docs.received", "review.started"]);
    expect(next.candidates[0]).toMatchObject({
      event: "approval.needed",
      probability: 1,
      matchedOrder: 2,
      support: 2,
      successRate: 1,
      failureRate: 0
    });
  });

  it("derives terminal case outcomes from explicit terminal events instead of trailing session events", async () => {
    const engine = await createEngine();

    await engine.ingestBatch([
      {
        caseId: "case-failed-terminal",
        ts: "2026-03-30T15:00:00.000Z",
        source: "openclaw.task",
        type: "task.started",
        outcome: "unknown"
      },
      {
        caseId: "case-failed-terminal",
        ts: "2026-03-30T15:01:00.000Z",
        source: "openclaw.task",
        type: "task.failed",
        outcome: "failure"
      },
      {
        caseId: "case-failed-terminal",
        ts: "2026-03-30T15:02:00.000Z",
        source: "openclaw.session",
        type: "session.ended",
        outcome: "success"
      },
      {
        caseId: "case-current-terminal",
        ts: "2026-03-30T16:00:00.000Z",
        source: "openclaw.task",
        type: "task.started",
        outcome: "unknown"
      }
    ]);

    const failedRecall = await engine.workflowRecall("case-current-terminal", "failed");
    expect(failedRecall.paths[0]).toMatchObject({
      caseId: "case-failed-terminal",
      outcome: "failure"
    });
  });

  it("ingests event batches with a single rebuild path", async () => {
    const engine = await createEngine();

    const events = await engine.ingestBatch([
      {
        caseId: "case-batch",
        ts: "2026-03-30T14:00:00.000Z",
        source: "openclaw.session",
        type: "session.started",
        outcome: "unknown"
      },
      {
        caseId: "case-batch",
        ts: "2026-03-30T14:01:00.000Z",
        source: "openclaw.tool",
        type: "tool.started",
        outcome: "unknown"
      },
      {
        caseId: "case-batch",
        ts: "2026-03-30T14:02:00.000Z",
        source: "openclaw.tool",
        type: "tool.succeeded",
        outcome: "success"
      }
    ]);

    expect(events).toHaveLength(3);

    const status = await engine.status();
    expect(status.events).toBe(3);

    const state = await engine.workflowState("case-batch");
    expect(state.state).toEqual(["session.started", "tool.started", "tool.succeeded"]);
  });

  it("reports event taxonomy cardinality and recent drift metrics", async () => {
    const engine = await createEngine();

    await engine.ingestBatch([
      {
        caseId: "case-taxonomy-1",
        ts: "2026-03-01T10:00:00.000Z",
        source: "openclaw.session",
        type: "session.started",
        outcome: "unknown"
      },
      {
        caseId: "case-taxonomy-1",
        ts: "2026-03-01T10:01:00.000Z",
        source: "tool.repo",
        type: "repo.inspected",
        outcome: "success"
      },
      {
        caseId: "case-taxonomy-1",
        ts: "2026-03-01T10:02:00.000Z",
        source: "tool.edit",
        type: "patch.applied",
        outcome: "success"
      },
      {
        caseId: "case-taxonomy-2",
        ts: "2026-03-02T10:00:00.000Z",
        source: "openclaw.session",
        type: "session.started",
        outcome: "unknown"
      },
      {
        caseId: "case-taxonomy-2",
        ts: "2026-03-02T10:01:00.000Z",
        source: "tool.repo",
        type: "repo.inspected",
        outcome: "success"
      },
      {
        caseId: "case-taxonomy-2",
        ts: "2026-03-02T10:02:00.000Z",
        source: "tool.edit",
        type: "patch.applied",
        outcome: "success"
      },
      {
        caseId: "case-taxonomy-3",
        ts: "2026-03-30T10:00:00.000Z",
        source: "openclaw.session",
        type: "session.started",
        outcome: "unknown"
      },
      {
        caseId: "case-taxonomy-3",
        ts: "2026-03-30T10:01:00.000Z",
        source: "tool.repo",
        type: "repo.inspected",
        outcome: "success"
      },
      {
        caseId: "case-taxonomy-3",
        ts: "2026-03-30T10:02:00.000Z",
        source: "tool.deploy",
        type: "deploy.checked",
        outcome: "success"
      }
    ]);

    const report = await engine.taxonomyReport({
      asOf: "2026-03-31T00:00:00.000Z",
      recentDays: 7,
      rareSupport: 1,
      limit: 5
    });

    expect(report.totalEvents).toBe(9);
    expect(report.distinctTypes).toBe(4);
    expect(report.topTypes.slice(0, 4)).toMatchObject([
      { event: "repo.inspected", count: 3, share: 0.333 },
      { event: "session.started", count: 3, share: 0.333 },
      { event: "patch.applied", count: 2, share: 0.222 },
      { event: "deploy.checked", count: 1, share: 0.111, isNewInRecentWindow: true, isRare: true }
    ]);
    expect(report.rareTypes).toHaveLength(1);
    expect(report.rareTypes[0]).toMatchObject({
      event: "deploy.checked",
      count: 1,
      recentCount: 1,
      baselineCount: 0
    });
    expect(report.recentNewTypes).toHaveLength(1);
    expect(report.recentNewTypes[0]?.event).toBe("deploy.checked");
    expect(report.drift).toMatchObject({
      recentWindowDays: 7,
      baselineEventCount: 6,
      baselineDistinctTypes: 3,
      recentEventCount: 3,
      recentDistinctTypes: 3,
      newTypeCount: 1,
      newTypeShare: 0.333,
      rareTypeCount: 1,
      rareEventShare: 0.111,
      score: 0.333
    });
  });

  it("reports cross-case workflow analytics", async () => {
    const engine = await createEngine();

    await engine.ingestBatch([
      {
        caseId: "case-analytics-1",
        ts: "2026-03-01T10:00:00.000Z",
        source: "openclaw.session",
        type: "session.started",
        outcome: "unknown"
      },
      {
        caseId: "case-analytics-1",
        ts: "2026-03-01T10:01:00.000Z",
        source: "tool.repo",
        type: "repo.inspected",
        outcome: "success"
      },
      {
        caseId: "case-analytics-1",
        ts: "2026-03-01T10:02:00.000Z",
        source: "tool.edit",
        type: "patch.applied",
        outcome: "success"
      },
      {
        caseId: "case-analytics-2",
        ts: "2026-03-02T10:00:00.000Z",
        source: "openclaw.session",
        type: "session.started",
        outcome: "unknown"
      },
      {
        caseId: "case-analytics-2",
        ts: "2026-03-02T10:01:00.000Z",
        source: "tool.repo",
        type: "repo.inspected",
        outcome: "success"
      },
      {
        caseId: "case-analytics-2",
        ts: "2026-03-02T10:02:00.000Z",
        source: "tool.env",
        type: "env.blocked",
        outcome: "failure"
      },
      {
        caseId: "case-analytics-3",
        ts: "2026-03-03T10:00:00.000Z",
        source: "openclaw.session",
        type: "session.started",
        outcome: "unknown"
      },
      {
        caseId: "case-analytics-3",
        ts: "2026-03-03T10:01:00.000Z",
        source: "tool.repo",
        type: "repo.inspected",
        outcome: "success"
      },
      {
        caseId: "case-analytics-3",
        ts: "2026-03-03T10:02:00.000Z",
        source: "tool.wait",
        type: "waiting.on.customer",
        outcome: "unknown"
      },
      {
        caseId: "case-analytics-3",
        ts: "2026-03-03T10:03:00.000Z",
        source: "openclaw.task",
        type: "task.ended",
        outcome: "unknown"
      }
    ]);

    const report = await engine.analyticsReport({
      asOf: "2026-03-31T00:00:00.000Z",
      limit: 3
    });

    expect(report.cases).toMatchObject({
      total: 3,
      success: 1,
      failure: 1,
      unknown: 1,
      successRate: 0.333,
      failureRate: 0.333
    });
    expect(report.hotTransitions[0]).toMatchObject({
      state: ["session.started"],
      nextEvent: "repo.inspected",
      support: 3
    });
    expect(report.failureBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nextEvent: "env.blocked",
          failureRate: 1
        })
      ])
    );
    expect(report.stallBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nextEvent: "task.ended",
          stallRate: 1
        })
      ])
    );
  });

  it("migrates older graph schemas before analytics queries", async () => {
    const engine = await createEngine();

    await fs.mkdir(path.dirname(engine.paths.graphPath), { recursive: true });
    const db = new DatabaseSync(engine.paths.graphPath);

    try {
      db.exec(`
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          agent_id TEXT NOT NULL,
          case_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          source TEXT NOT NULL,
          type TEXT NOT NULL
        );

        CREATE TABLE cases (
          case_id TEXT PRIMARY KEY
        );

        CREATE TABLE state_edges (
          order_n INTEGER NOT NULL,
          state_key TEXT NOT NULL,
          next_event TEXT NOT NULL,
          support INTEGER NOT NULL,
          PRIMARY KEY (order_n, state_key, next_event)
        );

        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        INSERT INTO cases (case_id) VALUES ('legacy-case');
        INSERT INTO state_edges (order_n, state_key, next_event, support)
        VALUES (1, 'session.started', 'repo.inspected', 2);
      `);
    } finally {
      db.close();
    }

    const report = await engine.analyticsReport({ limit: 5 });

    expect(report.cases).toMatchObject({
      total: 1,
      success: 0,
      failure: 0,
      unknown: 1
    });
    expect(report.hotTransitions[0]).toMatchObject({
      state: ["session.started"],
      nextEvent: "repo.inspected",
      support: 2
    });
  });

  it("exports a snapshot and performs gc maintenance", async () => {
    const engine = await createEngine();

    await engine.ingest({
      caseId: "case-export",
      ts: "2026-03-30T10:00:00.000Z",
      source: "tool.docs",
      type: "docs.requested",
      outcome: "success"
    });

    const status = await engine.status();
    expect(status.lastRebuildAt).not.toBeNull();
    expect(status.config.minSupport).toBe(1);

    const exportResult = await engine.exportSnapshot();
    expect(exportResult.caseCount).toBe(1);

    const exportContent = JSON.parse(await fs.readFile(exportResult.exportPath, "utf8")) as {
      status: { events: number };
      cases: Array<{ case_id: string }>;
    };
    expect(exportContent.status.events).toBe(1);
    expect(exportContent.cases[0]?.case_id).toBe("case-export");

    await fs.writeFile(path.join(engine.paths.tmpDir, "scratch.txt"), "tmp", "utf8");

    const extraExportPaths: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const exportPath = path.join(engine.paths.exportDir, `old-${index}.json`);
      extraExportPaths.push(exportPath);
      await fs.writeFile(exportPath, "{}", "utf8");
    }

    const gcResult = await engine.gc();
    expect(gcResult.vacuumed).toBe(true);
    expect(gcResult.removedTmpFiles).toBeGreaterThanOrEqual(1);
    expect(gcResult.removedExportFiles).toBeGreaterThanOrEqual(2);
  });

  it("imports events from an exported snapshot", async () => {
    const engine1 = await createEngine();

    await engine1.ingestBatch([
      {
        caseId: "case-import-1",
        ts: "2026-03-30T10:00:00.000Z",
        source: "tool.docs",
        type: "docs.requested",
        outcome: "success"
      },
      {
        caseId: "case-import-1",
        ts: "2026-03-30T10:01:00.000Z",
        source: "tool.docs",
        type: "docs.received",
        outcome: "success"
      },
      {
        caseId: "case-import-2",
        ts: "2026-03-30T11:00:00.000Z",
        source: "tool.review",
        type: "review.started",
        outcome: "unknown"
      }
    ]);

    const exportResult = await engine1.exportSnapshot();
    expect(exportResult.eventCount).toBe(3);
    expect(exportResult.caseCount).toBe(2);

    const engine2 = await createEngine();
    const status2Before = await engine2.status();
    expect(status2Before.events).toBe(0);

    const importResult = await engine2.importSnapshot(exportResult.exportPath);
    expect(importResult.eventCount).toBe(3);
    expect(importResult.caseCount).toBe(2);
    expect(importResult.fromExportedAt).toBe(exportResult.exportedAt);

    const status2After = await engine2.status();
    expect(status2After.events).toBe(3);
    expect(status2After.cases).toBe(2);
  });

  it("skips duplicate events on re-import", async () => {
    const engine = await createEngine();

    await engine.ingestBatch([
      {
        caseId: "case-dedup",
        ts: "2026-03-30T10:00:00.000Z",
        source: "tool.docs",
        type: "docs.requested",
        outcome: "success"
      },
      {
        caseId: "case-dedup",
        ts: "2026-03-30T10:01:00.000Z",
        source: "tool.docs",
        type: "docs.received",
        outcome: "success"
      }
    ]);

    const exportResult = await engine.exportSnapshot();

    const importResult1 = await engine.importSnapshot(exportResult.exportPath);
    expect(importResult1.eventCount).toBe(2);

    const importResult2 = await engine.importSnapshot(exportResult.exportPath);
    expect(importResult2.eventCount).toBe(2);

    const status = await engine.status();
    expect(status.events).toBe(2);
  });

  it("handles empty snapshot gracefully", async () => {
    const engine = await createEngine();
    const emptyPath = path.join(engine.paths.exportDir, "empty.json");
    await fs.mkdir(engine.paths.exportDir, { recursive: true });
    await fs.writeFile(emptyPath, JSON.stringify({ exportedAt: "2026-03-30T10:00:00.000Z", events: [] }), "utf8");

    const importResult = await engine.importSnapshot(emptyPath);
    expect(importResult.eventCount).toBe(0);
    expect(importResult.caseCount).toBe(0);
    expect(importResult.fromExportedAt).toBe("2026-03-30T10:00:00.000Z");
  });

  it("handles snapshot with no events key", async () => {
    const engine = await createEngine();
    const noEventsPath = path.join(engine.paths.exportDir, "no-events.json");
    await fs.mkdir(engine.paths.exportDir, { recursive: true });
    await fs.writeFile(noEventsPath, JSON.stringify({ exportedAt: "2026-03-30T10:00:00.000Z", cases: [] }), "utf8");

    const importResult = await engine.importSnapshot(noEventsPath);
    expect(importResult.eventCount).toBe(0);
    expect(importResult.caseCount).toBe(0);
    expect(importResult.fromExportedAt).toBe("2026-03-30T10:00:00.000Z");
  });
});
