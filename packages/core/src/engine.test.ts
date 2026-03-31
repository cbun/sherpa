import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SherpaEngine } from "./engine.js";

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
          matchedOrder: 3
        }),
        expect.objectContaining({
          branch: "waiting.on.customer",
          kind: "stall",
          matchedOrder: 3
        })
      ])
    );

    const recall = await engine.workflowRecall("case-current", "successful");
    expect(recall.paths[0]).toMatchObject({
      caseId: "case-1",
      outcome: "success",
      matchedOrder: 3,
      continuation: ["approval.needed", "approval.granted", "report.sent"]
    });

    const failedRecall = await engine.workflowRecall("case-current", "failed");
    expect(failedRecall.paths[0]).toMatchObject({
      caseId: "case-2",
      outcome: "failure",
      matchedOrder: 3,
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
});
