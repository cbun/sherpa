import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { CliSherpaBackend, HttpSherpaBackend, createSherpaBackend } from "./backend.js";
import { resolveSherpaPluginConfig } from "./config.js";

function createSpawnStub(
  responder: (command: string, args: string[], input: string) => { stdout: string; stderr?: string; code?: number }
) {
  return vi.fn((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let input = "";

    stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    stdin.on("finish", () => {
      const result = responder(command, args, input);
      if (result.stdout) {
        stdout.write(result.stdout);
      }
      if (result.stderr) {
        stderr.write(result.stderr);
      }
      stdout.end();
      stderr.end();
      queueMicrotask(() => {
        child.emit("close", result.code ?? 0, null);
      });
    });

    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = vi.fn();

    return child as never;
  });
}

describe("createSherpaBackend", () => {
  it("creates an embedded backend by default", () => {
    const resolved = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });
    const backend = createSherpaBackend(resolved);

    expect(typeof backend.status).toBe("function");
    expect(typeof backend.ingestBatch).toBe("function");
  });
});

describe("CliSherpaBackend", () => {
  it("sends batched ingest over stdin to the CLI transport", async () => {
    const spawnStub = createSpawnStub((_command, args, input) => {
      expect(args).toContain("ingest-batch");
      expect(args).toContain("--root");
      expect(args).toContain("/tmp/sherpa-alpha");
      expect(JSON.parse(input)).toEqual([
        {
          caseId: "case-1",
          source: "openclaw.dispatch",
          type: "message.received"
        }
      ]);

      return {
        stdout: JSON.stringify([
          {
            eventId: "evt-1",
            caseId: "case-1",
            source: "openclaw.dispatch",
            type: "message.received"
          }
        ])
      };
    });

    const resolved = resolveSherpaPluginConfig(
      {
        transport: {
          mode: "stdio",
          command: "sherpa"
        },
        store: {
          root: "/tmp/sherpa-{agentId}"
        }
      },
      { agentId: "alpha" }
    );
    const backend = new CliSherpaBackend(resolved, spawnStub as never);

    await expect(
      backend.ingestBatch([
        {
          caseId: "case-1",
          source: "openclaw.dispatch",
          type: "message.received"
        }
      ])
    ).resolves.toHaveLength(1);
  });

  it("passes workflow query flags to the CLI transport", async () => {
    const spawnStub = createSpawnStub((_command, args) => {
      expect(args).toEqual([
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
        "workflow-state",
        "--case-id",
        "case-1",
        "--max-order",
        "4"
      ]);

      return {
        stdout: JSON.stringify({
          caseId: "case-1",
          state: ["message.received"],
          confidence: 1,
          support: 1
        })
      };
    });

    const resolved = resolveSherpaPluginConfig(
      {
        transport: {
          mode: "stdio"
        },
        store: {
          root: "/tmp/sherpa-{agentId}"
        }
      },
      { agentId: "alpha" }
    );
    const backend = new CliSherpaBackend(resolved, spawnStub as never);

    await expect(backend.workflowState("case-1", 4)).resolves.toMatchObject({
      caseId: "case-1"
    });
  });
});

describe("HttpSherpaBackend", () => {
  it("posts RPC requests to the configured daemon base URL", async () => {
    const fetchStub = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8787/rpc");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        method: "workflowNext",
        params: {
          caseId: "case-1",
          limit: 2
        }
      });

      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            caseId: "case-1",
            candidates: []
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    const resolved = resolveSherpaPluginConfig(
      {
        transport: {
          mode: "http",
          baseUrl: "http://127.0.0.1:8787"
        }
      },
      { agentId: "alpha" }
    );
    const backend = new HttpSherpaBackend(resolved, fetchStub as never);

    await expect(backend.workflowNext("case-1", 2)).resolves.toMatchObject({
      caseId: "case-1"
    });
  });
});
