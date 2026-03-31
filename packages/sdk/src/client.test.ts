import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSherpaAgentRoot, SherpaClient } from "./client.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SherpaClient", () => {
  it("resolves the default per-agent root", () => {
    expect(resolveSherpaAgentRoot({ agentId: "alpha" })).toBe(path.join(os.homedir(), ".openclaw", "agents", "alpha", "sherpa"));
  });

  it("wraps the core engine for common ingest and query flows", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-sdk-"));
    tempDirs.push(baseDir);

    const client = SherpaClient.forAgent({
      agentId: "alpha",
      baseDir
    });

    await client.ingestBatch([
      {
        caseId: "case-sdk",
        ts: "2026-03-30T10:00:00.000Z",
        source: "tool.docs",
        type: "docs.requested",
        outcome: "success"
      },
      {
        caseId: "case-sdk",
        ts: "2026-03-30T10:01:00.000Z",
        source: "tool.docs",
        type: "docs.received",
        outcome: "success"
      }
    ]);

    const state = await client.workflowState("case-sdk");
    const status = await client.status();

    expect(client.rootDir).toBe(path.join(baseDir, "alpha", "sherpa"));
    expect(state.state).toEqual(["docs.requested", "docs.received"]);
    expect(status.events).toBe(2);
  });
});
