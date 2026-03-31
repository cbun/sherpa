import { afterEach, describe, expect, it, vi } from "vitest";

import { createSherpaMaintenanceRuntime } from "./maintenance.js";
import type { ResolvedSherpaPluginConfig } from "./config.js";

afterEach(() => {
  vi.useRealTimers();
});

function createResolved(storeRoot: string): ResolvedSherpaPluginConfig {
  return {
    storeRoot,
    engine: {
      rootDir: storeRoot,
      defaultOrder: 3,
      minOrder: 1,
      maxOrder: 5,
      minSupport: 1
    },
    ledger: {
      redactRawText: true,
      maxMetaBytes: 2048
    },
    capture: {
      messages: true,
      tools: true,
      browser: true,
      web: true,
      automation: true,
      memoryWrites: false
    },
    advisory: {
      enabled: false,
      injectThreshold: 0.75,
      maxCandidates: 3,
      maxRisks: 2,
      maxChars: 900
    },
    update: {
      onBoot: true,
      interval: "5m",
      intervalMs: 300000,
      debounceMs: 25,
      commandTimeoutMs: 3000,
      rebuildOnVersionChange: false
    },
    scope: {
      defaultAction: "deny",
      rules: [
        {
          action: "allow",
          match: {
            chatType: "direct"
          }
        }
      ]
    },
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    caseSplitting: {
      enabled: true,
      markers: ["/new", "/task", "task:", "case:"],
      auto: {
        enabled: true,
        idleTimeout: "30m",
        idleTimeoutMs: 1800000,
        minContentChars: 24,
        shiftPhrases: [
          "switching gears",
          "separate task",
          "separately",
          "another task",
          "another request",
          "different issue",
          "different question",
          "new issue",
          "new topic",
          "one more thing",
          "unrelated"
        ],
        maxTitleTokenOverlap: 0.25
      }
    }
  };
}

describe("createSherpaMaintenanceRuntime", () => {
  it("batches queued events and flushes them once per debounce window", async () => {
    vi.useFakeTimers();

    const ingestBatch = vi.fn().mockResolvedValue(undefined);
    const gc = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      resolved: createResolved("/tmp/sherpa-alpha"),
      engine: {
        ingestBatch,
        gc
      }
    };

    const maintenance = createSherpaMaintenanceRuntime({
      logger: {
        warn: vi.fn()
      },
      listRuntimes: () => [runtime as never],
      flushDebounceMs: (resolved) => resolved.update.debounceMs,
      maintenanceIntervalMs: () => 0,
      onBoot: () => false
    });

    maintenance.enqueueCapture(runtime as never, {
      caseId: "case-1",
      source: "openclaw.session",
      type: "session.started"
    });
    maintenance.enqueueCapture(runtime as never, {
      caseId: "case-1",
      source: "openclaw.tool",
      type: "tool.started"
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(ingestBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(ingestBatch).toHaveBeenCalledTimes(1);
    expect(ingestBatch).toHaveBeenCalledWith([
      expect.objectContaining({ type: "session.started" }),
      expect.objectContaining({ type: "tool.started" })
    ]);
  });

  it("runs boot and interval maintenance against known runtimes", async () => {
    vi.useFakeTimers();

    const ingestBatch = vi.fn().mockResolvedValue(undefined);
    const gc = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      resolved: createResolved("/tmp/sherpa-alpha"),
      engine: {
        ingestBatch,
        gc
      }
    };

    const maintenance = createSherpaMaintenanceRuntime({
      logger: {
        warn: vi.fn()
      },
      listRuntimes: () => [runtime as never],
      flushDebounceMs: (resolved) => resolved.update.debounceMs,
      maintenanceIntervalMs: () => 50,
      onBoot: () => true
    });

    maintenance.start();
    await vi.runOnlyPendingTimersAsync();

    expect(gc).toHaveBeenCalled();

    gc.mockClear();
    await vi.advanceTimersByTimeAsync(50);
    expect(gc).toHaveBeenCalledTimes(1);

    await maintenance.stop();
  });
});
