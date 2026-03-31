import { spawn, type ChildProcess } from "node:child_process";

import type { ResolvedSherpaPluginConfig } from "./config.js";
import { buildCliSharedArgs } from "./backend.js";

const HEALTH_POLL_MS = 100;
const INITIAL_RESTART_BACKOFF_MS = 250;
const MAX_RESTART_BACKOFF_MS = 5_000;

type SpawnLike = typeof spawn;
type FetchLike = typeof fetch;

interface ManagedDaemonState {
  child: ChildProcess | null;
  desired: boolean;
  resolved: ResolvedSherpaPluginConfig;
  respawnTimer: NodeJS.Timeout | null;
  restartDelayMs: number;
  fingerprint: string;
}

function isManagedHttpTransport(resolved: ResolvedSherpaPluginConfig) {
  return resolved.transport.mode === "http" && resolved.transport.manageProcess;
}

function buildFingerprint(resolved: ResolvedSherpaPluginConfig) {
  return JSON.stringify({
    storeRoot: resolved.storeRoot,
    transport: resolved.transport,
    engine: resolved.engine
  });
}

function isChildRunning(child: ChildProcess | null) {
  return Boolean(child && child.exitCode === null && !child.killed);
}

function createHealthTimeout(timeoutMs: number) {
  return timeoutMs > 0 ? { signal: AbortSignal.timeout(Math.min(500, timeoutMs)) } : {};
}

export function createManagedDaemonSupervisor(dependencies?: {
  spawnImpl?: SpawnLike;
  fetchImpl?: FetchLike;
}) {
  const spawnImpl = dependencies?.spawnImpl ?? spawn;
  const fetchImpl = dependencies?.fetchImpl ?? fetch;
  const states = new Map<string, ManagedDaemonState>();

  function clearRespawnTimer(state: ManagedDaemonState) {
    if (!state.respawnTimer) {
      return;
    }

    clearTimeout(state.respawnTimer);
    state.respawnTimer = null;
  }

  function scheduleRespawn(state: ManagedDaemonState) {
    if (!state.desired || state.respawnTimer) {
      return;
    }

    const delayMs = state.restartDelayMs;
    state.restartDelayMs = Math.min(state.restartDelayMs * 2, MAX_RESTART_BACKOFF_MS);
    state.respawnTimer = setTimeout(() => {
      state.respawnTimer = null;
      startProcess(state);
    }, delayMs);
  }

  function startProcess(state: ManagedDaemonState) {
    if (!state.desired || !isManagedHttpTransport(state.resolved) || isChildRunning(state.child)) {
      return;
    }

    const url = new URL(state.resolved.transport.baseUrl);
    const host = url.hostname;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");

    try {
      const child = spawnImpl(
        state.resolved.transport.command,
        [...buildCliSharedArgs(state.resolved), "serve", "--host", host, "--port", port],
        {
          env: {
            ...process.env,
            ...state.resolved.transport.env
          },
          stdio: "ignore"
        }
      );

      child.unref();
      child.once("exit", () => {
        if (state.child === child) {
          state.child = null;
        }

        if (state.desired) {
          scheduleRespawn(state);
        }
      });

      state.child = child;
    } catch {
      scheduleRespawn(state);
    }
  }

  function upsertState(resolved: ResolvedSherpaPluginConfig) {
    const fingerprint = buildFingerprint(resolved);
    let state = states.get(resolved.storeRoot);

    if (!state) {
      state = {
        child: null,
        desired: true,
        resolved,
        respawnTimer: null,
        restartDelayMs: INITIAL_RESTART_BACKOFF_MS,
        fingerprint
      };
      states.set(resolved.storeRoot, state);
      return state;
    }

    state.desired = true;
    if (state.fingerprint !== fingerprint) {
      clearRespawnTimer(state);
      const child = state.child;
      if (child && isChildRunning(child)) {
        child.kill("SIGTERM");
      }
      state.child = null;
      state.restartDelayMs = INITIAL_RESTART_BACKOFF_MS;
      state.fingerprint = fingerprint;
    }

    state.resolved = resolved;
    return state;
  }

  async function ensureReady(resolved: ResolvedSherpaPluginConfig) {
    if (!isManagedHttpTransport(resolved)) {
      return;
    }

    const state = upsertState(resolved);
    startProcess(state);

    const deadline = Date.now() + resolved.transport.timeoutMs;
    while (Date.now() < deadline) {
      if (!isChildRunning(state.child) && !state.respawnTimer) {
        startProcess(state);
      }

      try {
        const response = await fetchImpl(new URL("/health", resolved.transport.baseUrl), {
          ...createHealthTimeout(resolved.transport.timeoutMs)
        });

        if (response.ok) {
          state.restartDelayMs = INITIAL_RESTART_BACKOFF_MS;
          return;
        }
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }

    throw new Error(`Timed out waiting for Sherpa daemon at ${resolved.transport.baseUrl}`);
  }

  async function stopAll() {
    for (const state of states.values()) {
      state.desired = false;
      clearRespawnTimer(state);

      const child = state.child;
      if (child && isChildRunning(child)) {
        child.kill("SIGTERM");
      }

      state.child = null;
    }

    states.clear();
  }

  return {
    ensureReady,
    stopAll
  };
}
