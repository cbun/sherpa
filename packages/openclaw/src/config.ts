import os from "node:os";
import path from "node:path";

import type { SherpaEngineOptions } from "@sherpa/core";

export interface SherpaPluginConfig {
  transport?: {
    mode?: "embedded" | "stdio" | "http";
    command?: string;
    args?: string[];
    baseUrl?: string;
    manageProcess?: boolean;
    timeoutMs?: number;
    env?: Record<string, string>;
  };
  store?: {
    root?: string;
  };
  ledger?: {
    redactRawText?: boolean;
    maxMetaBytes?: number;
  };
  order?: {
    default?: number;
    min?: number;
    max?: number;
    backoff?: boolean;
    minSupport?: number;
  };
  advisory?: {
    enabled?: boolean;
    injectThreshold?: number;
    maxCandidates?: number;
    maxRisks?: number;
    maxChars?: number;
  };
  taxonomy?: {
    rules?: Array<{
      match?: {
        kind?: "message" | "session" | "task" | "tool";
        source?: string;
        type?: string;
        actor?: string;
        toolName?: string;
        toolFamily?: "tool" | "browser" | "web" | "automation";
        phase?: "started" | "succeeded" | "failed";
        channel?: string;
        contentPattern?: string;
      };
      set?: {
        type?: string;
        outcome?: "success" | "failure" | "unknown";
        labels?: string[];
      };
    }>;
  };
  update?: {
    onBoot?: boolean;
    interval?: string;
    debounceMs?: number;
    commandTimeoutMs?: number;
    rebuildOnVersionChange?: boolean;
  };
  scope?: {
    default?: "allow" | "deny";
    rules?: Array<{
      action: "allow" | "deny";
      match?: {
        chatType?: "direct" | "group" | "channel" | "dm";
        channel?: string;
        sessionPrefix?: string;
        rawSessionPrefix?: string;
        agentId?: string;
      };
    }>;
  };
  ignoreSessionPatterns?: string[];
  statelessSessionPatterns?: string[];
  caseSplitting?: {
    enabled?: boolean;
    markers?: string[];
    completeMarkers?: string[];
    failMarkers?: string[];
    auto?: {
      enabled?: boolean;
      idleTimeout?: string;
      staleTimeout?: string;
      minContentChars?: number;
      shiftPhrases?: string[];
      maxTitleTokenOverlap?: number;
      acknowledgmentPhrases?: string[];
      completePhrases?: string[];
      failPhrases?: string[];
    };
  };
  capture?: {
    messages?: boolean;
    tools?: boolean;
    browser?: boolean;
    web?: boolean;
    automation?: boolean;
    memoryWrites?: boolean;
  };
}

export interface ResolvedSherpaPluginConfig {
  transport: {
    mode: "embedded" | "stdio" | "http";
    command: string;
    args: string[];
    baseUrl: string;
    manageProcess: boolean;
    timeoutMs: number;
    env: Record<string, string>;
  };
  storeRoot: string;
  engine: SherpaEngineOptions;
  ledger: {
    redactRawText: boolean;
    maxMetaBytes: number;
  };
  capture: {
    messages: boolean;
    tools: boolean;
    browser: boolean;
    web: boolean;
    automation: boolean;
    memoryWrites: boolean;
  };
  advisory: {
    enabled: boolean;
    injectThreshold: number;
    maxCandidates: number;
    maxRisks: number;
    maxChars: number;
  };
  taxonomy: {
    rules: Array<{
      match: {
        kind?: "message" | "session" | "task" | "tool";
        source?: string;
        type?: string;
        actor?: string;
        toolName?: string;
        toolFamily?: "tool" | "browser" | "web" | "automation";
        phase?: "started" | "succeeded" | "failed";
        channel?: string;
        contentPattern?: string;
      };
      set: {
        type?: string;
        outcome?: "success" | "failure" | "unknown";
        labels: string[];
      };
    }>;
  };
  update: {
    onBoot: boolean;
    interval: string;
    intervalMs: number;
    debounceMs: number;
    commandTimeoutMs: number;
    rebuildOnVersionChange: boolean;
  };
  scope: {
    defaultAction: "allow" | "deny";
    rules: Array<{
      action: "allow" | "deny";
      match: {
        chatType?: "direct" | "group" | "channel" | "dm";
        channel?: string;
        sessionPrefix?: string;
        rawSessionPrefix?: string;
        agentId?: string;
      };
    }>;
  };
  ignoreSessionPatterns: string[];
  statelessSessionPatterns: string[];
  caseSplitting: {
    enabled: boolean;
    markers: string[];
    completeMarkers: string[];
    failMarkers: string[];
    auto: {
      enabled: boolean;
      idleTimeout: string;
      idleTimeoutMs: number;
      staleTimeout: string;
      staleTimeoutMs: number;
      minContentChars: number;
      shiftPhrases: string[];
      maxTitleTokenOverlap: number;
      acknowledgmentPhrases: string[];
      completePhrases: string[];
      failPhrases: string[];
    };
  };
}

function expandHomeDir(value: string) {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function parseDurationMs(value: string | undefined, fallbackMs: number) {
  if (!value) {
    return fallbackMs;
  }

  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+)(ms|s|m|h)$/);

  if (!match) {
    return fallbackMs;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return fallbackMs;
  }
}

export function resolveSherpaPluginConfig(
  config: SherpaPluginConfig | undefined,
  context?: {
    agentId?: string;
    cwd?: string;
  }
): ResolvedSherpaPluginConfig {
  const agentId = context?.agentId ?? "main";
  const configuredRoot = config?.store?.root ?? "~/.openclaw/agents/{agentId}/sherpa";
  const storeRoot = expandHomeDir(configuredRoot.replaceAll("{agentId}", agentId));

  return {
    transport: {
      mode: config?.transport?.mode ?? "embedded",
      command: config?.transport?.command ?? "sherpa",
      args: config?.transport?.args ?? [],
      baseUrl: config?.transport?.baseUrl ?? "http://127.0.0.1:8787",
      manageProcess: config?.transport?.manageProcess ?? false,
      timeoutMs: config?.transport?.timeoutMs ?? config?.update?.commandTimeoutMs ?? 3000,
      env: config?.transport?.env ?? {}
    },
    storeRoot,
    engine: {
      rootDir: storeRoot,
      defaultOrder: config?.order?.default ?? 3,
      minOrder: config?.order?.min ?? 1,
      maxOrder: config?.order?.max ?? 5,
      minSupport: config?.order?.minSupport ?? 1
    },
    ledger: {
      redactRawText: config?.ledger?.redactRawText ?? true,
      maxMetaBytes: config?.ledger?.maxMetaBytes ?? 2048
    },
    capture: {
      messages: config?.capture?.messages ?? true,
      tools: config?.capture?.tools ?? true,
      browser: config?.capture?.browser ?? true,
      web: config?.capture?.web ?? true,
      automation: config?.capture?.automation ?? true,
      memoryWrites: config?.capture?.memoryWrites ?? false
    },
    advisory: {
      enabled: config?.advisory?.enabled ?? true,
      injectThreshold: config?.advisory?.injectThreshold ?? 0.75,
      maxCandidates: config?.advisory?.maxCandidates ?? 3,
      maxRisks: config?.advisory?.maxRisks ?? 2,
      maxChars: config?.advisory?.maxChars ?? 900
    },
    taxonomy: {
      rules:
        config?.taxonomy?.rules?.map((rule) => ({
          match: {
            ...(rule.match?.kind ? { kind: rule.match.kind } : {}),
            ...(rule.match?.source ? { source: rule.match.source } : {}),
            ...(rule.match?.type ? { type: rule.match.type } : {}),
            ...(rule.match?.actor ? { actor: rule.match.actor } : {}),
            ...(rule.match?.toolName ? { toolName: rule.match.toolName } : {}),
            ...(rule.match?.toolFamily ? { toolFamily: rule.match.toolFamily } : {}),
            ...(rule.match?.phase ? { phase: rule.match.phase } : {}),
            ...(rule.match?.channel ? { channel: rule.match.channel } : {}),
            ...(rule.match?.contentPattern ? { contentPattern: rule.match.contentPattern } : {})
          },
          set: {
            ...(rule.set?.type ? { type: rule.set.type } : {}),
            ...(rule.set?.outcome ? { outcome: rule.set.outcome } : {}),
            labels: rule.set?.labels ?? []
          }
        })) ?? []
    },
    update: {
      onBoot: config?.update?.onBoot ?? true,
      interval: config?.update?.interval ?? "5m",
      intervalMs: parseDurationMs(config?.update?.interval, 300_000),
      debounceMs: config?.update?.debounceMs ?? 10_000,
      commandTimeoutMs: config?.update?.commandTimeoutMs ?? 3_000,
      rebuildOnVersionChange: config?.update?.rebuildOnVersionChange ?? false
    },
    scope: {
      defaultAction: config?.scope?.default ?? "deny",
      rules:
        config?.scope?.rules?.map((rule) => ({
          action: rule.action,
          match: {
            ...(rule.match?.chatType ? { chatType: rule.match.chatType } : {}),
            ...(rule.match?.channel ? { channel: rule.match.channel } : {}),
            ...(rule.match?.sessionPrefix ? { sessionPrefix: rule.match.sessionPrefix } : {}),
            ...(rule.match?.rawSessionPrefix ? { rawSessionPrefix: rule.match.rawSessionPrefix } : {}),
            ...(rule.match?.agentId ? { agentId: rule.match.agentId } : {})
          }
        })) ?? [
          {
            action: "allow",
            match: {
              chatType: "direct"
            }
          },
          {
            action: "allow",
            match: {
              chatType: "dm"
            }
          }
        ]
    },
    ignoreSessionPatterns: config?.ignoreSessionPatterns ?? ["agent:*:cron:**"],
    statelessSessionPatterns: config?.statelessSessionPatterns ?? [],
    caseSplitting: {
      enabled: config?.caseSplitting?.enabled ?? true,
      markers: config?.caseSplitting?.markers ?? ["/new", "/task", "task:", "case:"],
      completeMarkers: config?.caseSplitting?.completeMarkers ?? ["/done", "/complete", "done:", "complete:"],
      failMarkers: config?.caseSplitting?.failMarkers ?? ["/fail", "/failed", "failed:", "blocked:"],
      auto: {
        enabled: config?.caseSplitting?.auto?.enabled ?? true,
        idleTimeout: config?.caseSplitting?.auto?.idleTimeout ?? "30m",
        idleTimeoutMs: parseDurationMs(config?.caseSplitting?.auto?.idleTimeout, 1_800_000),
        staleTimeout: config?.caseSplitting?.auto?.staleTimeout ?? "2h",
        staleTimeoutMs: parseDurationMs(config?.caseSplitting?.auto?.staleTimeout, 7_200_000),
        minContentChars: config?.caseSplitting?.auto?.minContentChars ?? 24,
        shiftPhrases: config?.caseSplitting?.auto?.shiftPhrases ?? [
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
        maxTitleTokenOverlap: config?.caseSplitting?.auto?.maxTitleTokenOverlap ?? 0.25,
        acknowledgmentPhrases: config?.caseSplitting?.auto?.acknowledgmentPhrases ?? [
          "thanks",
          "thank you",
          "got it",
          "sounds good",
          "ok",
          "okay",
          "perfect"
        ],
        completePhrases: config?.caseSplitting?.auto?.completePhrases ?? [
          "that solved it",
          "that worked",
          "issue resolved",
          "problem solved",
          "we are good",
          "we're good",
          "fixed now"
        ],
        failPhrases: config?.caseSplitting?.auto?.failPhrases ?? [
          "still blocked",
          "this failed",
          "that failed",
          "did not work",
          "didn't work",
          "cannot proceed",
          "can't proceed"
        ]
      }
    }
  };
}
