import type { SherpaEngine, SherpaEventInput } from "@sherpa/core";

import type { ResolvedSherpaPluginConfig } from "./config.js";

export interface SherpaPluginRuntime {
  engine: SherpaEngine;
  resolved: ResolvedSherpaPluginConfig;
}

export interface SherpaMaintenanceLogger {
  warn(message: string): void;
}

export interface SherpaMaintenanceRuntime {
  enqueueCapture(runtime: SherpaPluginRuntime, event: SherpaEventInput | null): void;
  start(): void;
  stop(): Promise<void>;
}

type PendingBatch = {
  runtime: SherpaPluginRuntime;
  events: SherpaEventInput[];
  flushHandle: NodeJS.Timeout | null;
};

function createWarning(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createSherpaMaintenanceRuntime(params: {
  logger: SherpaMaintenanceLogger;
  listRuntimes: () => SherpaPluginRuntime[];
  flushDebounceMs: (resolved: ResolvedSherpaPluginConfig) => number;
  maintenanceIntervalMs: () => number;
  onBoot: () => boolean;
}): SherpaMaintenanceRuntime {
  const pending = new Map<string, PendingBatch>();
  let intervalHandle: NodeJS.Timeout | null = null;
  let stopped = false;

  async function flushStore(storeRoot: string) {
    const batch = pending.get(storeRoot);
    if (!batch || batch.events.length === 0) {
      return;
    }

    pending.delete(storeRoot);

    if (batch.flushHandle) {
      clearTimeout(batch.flushHandle);
    }

    const events = batch.events.splice(0);

    try {
      await batch.runtime.engine.ingestBatch(events);
    } catch (error) {
      params.logger.warn(`Sherpa maintenance flush skipped: ${createWarning(error)}`);
    }
  }

  function scheduleFlush(storeRoot: string, batch: PendingBatch) {
    if (batch.flushHandle) {
      clearTimeout(batch.flushHandle);
    }

    const debounceMs = params.flushDebounceMs(batch.runtime.resolved);
    if (debounceMs <= 0) {
      void flushStore(storeRoot);
      return;
    }

    batch.flushHandle = setTimeout(() => {
      void flushStore(storeRoot);
    }, debounceMs);
  }

  async function flushAll() {
    await Promise.all([...pending.keys()].map((storeRoot) => flushStore(storeRoot)));
  }

  async function runMaintenancePass() {
    await flushAll();

    await Promise.all(
      params.listRuntimes().map(async ({ engine }) => {
        try {
          await engine.gc();
        } catch (error) {
          params.logger.warn(`Sherpa maintenance skipped: ${createWarning(error)}`);
        }
      })
    );
  }

  return {
    enqueueCapture(runtime, event) {
      if (stopped || !event) {
        return;
      }

      const storeRoot = runtime.resolved.storeRoot;
      const batch = pending.get(storeRoot) ?? {
        runtime,
        events: [],
        flushHandle: null
      };

      batch.runtime = runtime;
      batch.events.push(event);
      pending.set(storeRoot, batch);
      scheduleFlush(storeRoot, batch);
    },
    start() {
      stopped = false;

      if (params.onBoot()) {
        void runMaintenancePass();
      }

      const intervalMs = params.maintenanceIntervalMs();
      if (intervalMs > 0) {
        intervalHandle = setInterval(() => {
          void runMaintenancePass();
        }, intervalMs);
      }
    },
    async stop() {
      stopped = true;

      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }

      for (const batch of pending.values()) {
        if (batch.flushHandle) {
          clearTimeout(batch.flushHandle);
          batch.flushHandle = null;
        }
      }

      await flushAll();
    }
  };
}
