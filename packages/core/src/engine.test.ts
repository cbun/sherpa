import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SherpaEngine } from "./engine.js";

const tempDirs: string[] = [];

async function createEngine() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-core-"));
  tempDirs.push(rootDir);
  return new SherpaEngine({ rootDir, defaultOrder: 3, maxOrder: 4 });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SherpaEngine", () => {
  it("rebuilds graph state from the ledger and returns workflow predictions", async () => {
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
        outcome: "success" as const,
        labels: ["workflow:vendor-review"]
      }
    ];

    for (const event of events) {
      await engine.ingest(event);
    }

    const status = await engine.status();
    expect(status.events).toBe(7);
    expect(status.cases).toBe(2);

    const state = await engine.workflowState("case-2");
    expect(state.state).toEqual(["docs.requested", "docs.received", "review.started"]);
    expect(state.matchedWorkflow).toBe("workflow:vendor-review");

    const next = await engine.workflowNext("case-2");
    expect(next.candidates[0]).toMatchObject({
      event: "approval.needed",
      probability: 1,
      support: 1,
      matchedOrder: 3
    });
  });
});
