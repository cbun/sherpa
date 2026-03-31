import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSherpaPluginConfig } from "./config.js";

describe("resolveSherpaPluginConfig", () => {
  it("fills defaults and expands the agent root template", () => {
    const resolved = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });

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
    expect(resolved.advisory.enabled).toBe(false);
  });

  it("respects configured overrides", () => {
    const resolved = resolveSherpaPluginConfig(
      {
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
        statelessSessionPatterns: ["agent:beta:discord:**"]
      },
      { agentId: "beta" }
    );

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
  });
});
