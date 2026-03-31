import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSherpaPluginConfig } from "./config.js";

describe("resolveSherpaPluginConfig", () => {
  it("fills defaults and expands the agent root template", () => {
    const resolved = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });

    expect(resolved.transport).toEqual({
      mode: "embedded",
      command: "sherpa",
      args: [],
      timeoutMs: 3000,
      env: {}
    });
    expect(resolved.storeRoot).toBe(path.join(os.homedir(), ".openclaw/agents/alpha/sherpa"));
    expect(resolved.engine).toMatchObject({
      rootDir: path.join(os.homedir(), ".openclaw/agents/alpha/sherpa"),
      defaultOrder: 3,
      minOrder: 1,
      maxOrder: 5,
      minSupport: 1
    });
    expect(resolved.ledger).toMatchObject({
      redactRawText: true,
      maxMetaBytes: 2048
    });
    expect(resolved.capture).toMatchObject({
      messages: true,
      tools: true,
      browser: true,
      web: true,
      automation: true,
      memoryWrites: false
    });
    expect(resolved.update).toMatchObject({
      onBoot: true,
      interval: "5m",
      intervalMs: 300000,
      debounceMs: 10000,
      commandTimeoutMs: 3000,
      rebuildOnVersionChange: false
    });
    expect(resolved.scope).toMatchObject({
      defaultAction: "deny",
      rules: [
        { action: "allow", match: { chatType: "direct" } },
        { action: "allow", match: { chatType: "dm" } }
      ]
    });
    expect(resolved.ignoreSessionPatterns).toEqual(["agent:*:cron:**"]);
    expect(resolved.statelessSessionPatterns).toEqual([]);
    expect(resolved.caseSplitting).toEqual({
      enabled: true,
      markers: ["/new", "/task", "task:", "case:"],
      completeMarkers: ["/done", "/complete", "done:", "complete:"],
      failMarkers: ["/fail", "/failed", "failed:", "blocked:"],
      auto: {
        enabled: true,
        idleTimeout: "30m",
        idleTimeoutMs: 1800000,
        staleTimeout: "2h",
        staleTimeoutMs: 7200000,
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
    });
    expect(resolved.advisory.enabled).toBe(false);
  });

  it("respects configured overrides", () => {
    const resolved = resolveSherpaPluginConfig(
      {
        transport: {
          mode: "stdio",
          command: "node",
          args: ["./dist/index.js"],
          timeoutMs: 15000,
          env: {
            SHERPA_LOG_LEVEL: "debug"
          }
        },
        store: {
          root: "/tmp/sherpa/{agentId}"
        },
        ledger: {
          redactRawText: false,
          maxMetaBytes: 512
        },
        order: {
          default: 4,
          min: 2,
          max: 6,
          minSupport: 3
        },
        advisory: {
          enabled: true,
          injectThreshold: 0.9,
          maxCandidates: 5,
          maxRisks: 4,
          maxChars: 1200
        },
        update: {
          onBoot: false,
          interval: "30s",
          debounceMs: 250,
          commandTimeoutMs: 1500,
          rebuildOnVersionChange: true
        },
        scope: {
          default: "allow",
          rules: [
            {
              action: "deny",
              match: {
                channel: "discord"
              }
            }
          ]
        },
        ignoreSessionPatterns: ["agent:beta:slack:**"],
        statelessSessionPatterns: ["agent:beta:discord:**"],
        caseSplitting: {
          enabled: false,
          markers: ["/focus", "ticket:"],
          completeMarkers: ["/ship"],
          failMarkers: ["/blocked"],
          auto: {
            enabled: false,
            idleTimeout: "10m",
            staleTimeout: "1h",
            minContentChars: 12,
            shiftPhrases: ["switching gears", "new topic"],
            maxTitleTokenOverlap: 0.1
          }
        }
      },
      { agentId: "beta" }
    );

    expect(resolved.transport).toEqual({
      mode: "stdio",
      command: "node",
      args: ["./dist/index.js"],
      timeoutMs: 15000,
      env: {
        SHERPA_LOG_LEVEL: "debug"
      }
    });
    expect(resolved.storeRoot).toBe("/tmp/sherpa/beta");
    expect(resolved.engine).toMatchObject({
      rootDir: "/tmp/sherpa/beta",
      defaultOrder: 4,
      minOrder: 2,
      maxOrder: 6,
      minSupport: 3
    });
    expect(resolved.ledger).toMatchObject({
      redactRawText: false,
      maxMetaBytes: 512
    });
    expect(resolved.advisory).toMatchObject({
      enabled: true,
      injectThreshold: 0.9,
      maxCandidates: 5,
      maxRisks: 4,
      maxChars: 1200
    });
    expect(resolved.update).toMatchObject({
      onBoot: false,
      interval: "30s",
      intervalMs: 30000,
      debounceMs: 250,
      commandTimeoutMs: 1500,
      rebuildOnVersionChange: true
    });
    expect(resolved.scope).toMatchObject({
      defaultAction: "allow",
      rules: [
        {
          action: "deny",
          match: {
            channel: "discord"
          }
        }
      ]
    });
    expect(resolved.ignoreSessionPatterns).toEqual(["agent:beta:slack:**"]);
    expect(resolved.statelessSessionPatterns).toEqual(["agent:beta:discord:**"]);
    expect(resolved.caseSplitting).toEqual({
      enabled: false,
      markers: ["/focus", "ticket:"],
      completeMarkers: ["/ship"],
      failMarkers: ["/blocked"],
      auto: {
        enabled: false,
        idleTimeout: "10m",
        idleTimeoutMs: 600000,
        staleTimeout: "1h",
        staleTimeoutMs: 3600000,
        minContentChars: 12,
        shiftPhrases: ["switching gears", "new topic"],
        maxTitleTokenOverlap: 0.1
      }
    });
  });
});
