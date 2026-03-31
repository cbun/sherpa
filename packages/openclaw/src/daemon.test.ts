import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createManagedDaemonSupervisor } from "./daemon.js";
import { resolveSherpaPluginConfig } from "./config.js";

interface FakeChildProcess extends EventEmitter {
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

function createFakeChild() {
  const child = new EventEmitter() as FakeChildProcess;
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    child.exitCode = signal ? 0 : child.exitCode;
  });
  child.unref = vi.fn();
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createManagedDaemonSupervisor", () => {
  it("spawns the Sherpa CLI daemon for managed HTTP transports", async () => {
    const child = createFakeChild();
    const spawnStub = vi.fn(() => child);
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    const supervisor = createManagedDaemonSupervisor({
      spawnImpl: spawnStub as never,
      fetchImpl: fetchStub as never
    });
    const resolved = resolveSherpaPluginConfig(
      {
        transport: {
          mode: "http",
          manageProcess: true
        },
        store: {
          root: "/tmp/sherpa-{agentId}"
        }
      },
      { agentId: "alpha" }
    );

    await expect(supervisor.ensureReady(resolved)).resolves.toBeUndefined();

    expect(spawnStub).toHaveBeenCalledWith(
      "sherpa",
      [
        "--root",
        "/tmp/sherpa-alpha",
        "--default-order",
        "3",
        "--min-order",
        "1",
        "--max-order",
        "5",
        "--min-support",
        "1",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "8787"
      ],
      expect.objectContaining({
        stdio: "ignore"
      })
    );
    expect(child.unref).toHaveBeenCalled();

    await supervisor.stopAll();
  });

  it("restarts crashed managed daemons with backoff and waits for health", async () => {
    vi.useFakeTimers();

    const children: FakeChildProcess[] = [];
    const spawnStub = vi.fn(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });
    const fetchStub = vi.fn(async () => {
      if (children.length < 2) {
        throw new Error("daemon unavailable");
      }

      return new Response("ok", { status: 200 });
    });
    const supervisor = createManagedDaemonSupervisor({
      spawnImpl: spawnStub as never,
      fetchImpl: fetchStub as never
    });
    const resolved = resolveSherpaPluginConfig({
      transport: {
        mode: "http",
        manageProcess: true,
        timeoutMs: 2000
      }
    });

    const ready = supervisor.ensureReady(resolved);
    await Promise.resolve();

    expect(spawnStub).toHaveBeenCalledTimes(1);

    const firstChild = children[0];
    expect(firstChild).toBeDefined();
    firstChild!.exitCode = 1;
    firstChild!.emit("exit", 1, null);

    await vi.advanceTimersByTimeAsync(249);
    expect(spawnStub).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(spawnStub).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(100);
    await expect(ready).resolves.toBeUndefined();

    await supervisor.stopAll();
  });
});
