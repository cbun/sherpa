import os from "node:os";
import path from "node:path";

import type { SherpaEngineOptions } from "@sherpa/core";

export interface SherpaPluginConfig {
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
  update?: {
    onBoot?: boolean;
    interval?: string;
    debounceMs?: number;
    commandTimeoutMs?: number;
    rebuildOnVersionChange?: boolean;
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
  update: {
    onBoot: boolean;
    interval: string;
    intervalMs: number;
    debounceMs: number;
    commandTimeoutMs: number;
    rebuildOnVersionChange: boolean;
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
      enabled: config?.advisory?.enabled ?? false,
      injectThreshold: config?.advisory?.injectThreshold ?? 0.75,
      maxCandidates: config?.advisory?.maxCandidates ?? 3,
      maxRisks: config?.advisory?.maxRisks ?? 2,
      maxChars: config?.advisory?.maxChars ?? 900
    },
    update: {
      onBoot: config?.update?.onBoot ?? true,
      interval: config?.update?.interval ?? "5m",
      intervalMs: parseDurationMs(config?.update?.interval, 300_000),
      debounceMs: config?.update?.debounceMs ?? 10_000,
      commandTimeoutMs: config?.update?.commandTimeoutMs ?? 3_000,
      rebuildOnVersionChange: config?.update?.rebuildOnVersionChange ?? false
    }
  };
}
