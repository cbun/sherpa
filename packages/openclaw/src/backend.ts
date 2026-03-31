import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  SherpaEngine,
  type DoctorResult,
  type ExportResult,
  type GcResult,
  type SherpaEngineOptions,
  type SherpaEvent,
  type SherpaEventInput,
  type WorkflowNextResult,
  type WorkflowRecallMode,
  type WorkflowRecallResult,
  type WorkflowRisksResult,
  type WorkflowStateResult,
  type WorkflowStatusResult
} from "@sherpa/core";

import type { ResolvedSherpaPluginConfig } from "./config.js";

export interface SherpaBackend {
  init(): Promise<void>;
  ingest(event: SherpaEventInput): Promise<SherpaEvent>;
  ingestBatch(events: SherpaEventInput[]): Promise<SherpaEvent[]>;
  rebuild(): Promise<void>;
  status(): Promise<WorkflowStatusResult>;
  doctor(): Promise<DoctorResult>;
  exportSnapshot(): Promise<ExportResult>;
  gc(): Promise<GcResult>;
  workflowState(caseId: string, maxOrder?: number): Promise<WorkflowStateResult>;
  workflowNext(caseId: string, limit?: number): Promise<WorkflowNextResult>;
  workflowRisks(caseId: string, limit?: number): Promise<WorkflowRisksResult>;
  workflowRecall(caseId: string, mode?: WorkflowRecallMode, limit?: number): Promise<WorkflowRecallResult>;
}

export interface SherpaPluginRuntime {
  backend: SherpaBackend;
  resolved: ResolvedSherpaPluginConfig;
}

class InProcessSherpaBackend implements SherpaBackend {
  constructor(private readonly engine: SherpaEngine) {}

  init() {
    return this.engine.init();
  }

  ingest(event: SherpaEventInput) {
    return this.engine.ingest(event);
  }

  ingestBatch(events: SherpaEventInput[]) {
    return this.engine.ingestBatch(events);
  }

  rebuild() {
    return this.engine.rebuild();
  }

  status() {
    return this.engine.status();
  }

  doctor() {
    return this.engine.doctor();
  }

  exportSnapshot() {
    return this.engine.exportSnapshot();
  }

  gc() {
    return this.engine.gc();
  }

  workflowState(caseId: string, maxOrder?: number) {
    return this.engine.workflowState(caseId, maxOrder);
  }

  workflowNext(caseId: string, limit?: number) {
    return this.engine.workflowNext(caseId, limit);
  }

  workflowRisks(caseId: string, limit?: number) {
    return this.engine.workflowRisks(caseId, limit);
  }

  workflowRecall(caseId: string, mode?: WorkflowRecallMode, limit?: number) {
    return this.engine.workflowRecall(caseId, mode, limit);
  }
}

type SpawnLike = typeof spawn;

function collectOutput(child: ChildProcessWithoutNullStreams, stdinText?: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        resolve({ stdout, stderr, code, signal });
      });

      if (stdinText !== undefined) {
        child.stdin.write(stdinText);
      }

      child.stdin.end();
    }
  );
}

export class CliSherpaBackend implements SherpaBackend {
  constructor(
    private readonly resolved: ResolvedSherpaPluginConfig,
    private readonly spawnImpl: SpawnLike = spawn
  ) {}

  private sharedArgs() {
    const args = [...this.resolved.transport.args, "--root", this.resolved.storeRoot];

    if (this.resolved.engine.defaultOrder !== undefined) {
      args.push("--default-order", String(this.resolved.engine.defaultOrder));
    }

    if (this.resolved.engine.minOrder !== undefined) {
      args.push("--min-order", String(this.resolved.engine.minOrder));
    }

    if (this.resolved.engine.maxOrder !== undefined) {
      args.push("--max-order", String(this.resolved.engine.maxOrder));
    }

    if (this.resolved.engine.minSupport !== undefined) {
      args.push("--min-support", String(this.resolved.engine.minSupport));
    }

    return args;
  }

  private async runJson<T>(commandArgs: string[], stdinPayload?: unknown): Promise<T> {
    const child = this.spawnImpl(this.resolved.transport.command, commandArgs, {
      env: {
        ...process.env,
        ...this.resolved.transport.env
      },
      stdio: "pipe"
    });

    const timeoutMs = this.resolved.transport.timeoutMs;
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
          }, timeoutMs)
        : null;

    try {
      const result = await collectOutput(
        child,
        stdinPayload === undefined ? undefined : JSON.stringify(stdinPayload)
      );

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (result.code !== 0) {
        const message = result.stderr.trim() || result.stdout.trim() || `CLI exited with code ${result.code ?? "unknown"}`;
        throw new Error(message);
      }

      return JSON.parse(result.stdout) as T;
    } catch (error) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Sherpa CLI transport failed: ${message}`);
    }
  }

  async init() {
    await this.status();
  }

  ingest(event: SherpaEventInput) {
    return this.runJson<SherpaEvent>([...this.sharedArgs(), "ingest"], event);
  }

  ingestBatch(events: SherpaEventInput[]) {
    return this.runJson<SherpaEvent[]>([...this.sharedArgs(), "ingest-batch"], events);
  }

  async rebuild() {
    await this.runJson<WorkflowStatusResult>([...this.sharedArgs(), "rebuild"]);
  }

  status() {
    return this.runJson<WorkflowStatusResult>([...this.sharedArgs(), "status"]);
  }

  doctor() {
    return this.runJson<DoctorResult>([...this.sharedArgs(), "doctor"]);
  }

  exportSnapshot() {
    return this.runJson<ExportResult>([...this.sharedArgs(), "export"]);
  }

  gc() {
    return this.runJson<GcResult>([...this.sharedArgs(), "gc"]);
  }

  workflowState(caseId: string, maxOrder?: number) {
    return this.runJson<WorkflowStateResult>(
      [
        ...this.sharedArgs(),
        "workflow-state",
        "--case-id",
        caseId,
        ...(maxOrder !== undefined ? ["--max-order", String(maxOrder)] : [])
      ]
    );
  }

  workflowNext(caseId: string, limit?: number) {
    return this.runJson<WorkflowNextResult>(
      [
        ...this.sharedArgs(),
        "workflow-next",
        "--case-id",
        caseId,
        ...(limit !== undefined ? ["--limit", String(limit)] : [])
      ]
    );
  }

  workflowRisks(caseId: string, limit?: number) {
    return this.runJson<WorkflowRisksResult>(
      [
        ...this.sharedArgs(),
        "workflow-risks",
        "--case-id",
        caseId,
        ...(limit !== undefined ? ["--limit", String(limit)] : [])
      ]
    );
  }

  workflowRecall(caseId: string, mode?: WorkflowRecallMode, limit?: number) {
    return this.runJson<WorkflowRecallResult>(
      [
        ...this.sharedArgs(),
        "workflow-recall",
        "--case-id",
        caseId,
        ...(mode !== undefined ? ["--mode", mode] : []),
        ...(limit !== undefined ? ["--limit", String(limit)] : [])
      ]
    );
  }
}

export function createSherpaBackend(resolved: ResolvedSherpaPluginConfig, spawnImpl?: SpawnLike): SherpaBackend {
  if (resolved.transport.mode === "stdio") {
    return new CliSherpaBackend(resolved, spawnImpl);
  }

  return new InProcessSherpaBackend(new SherpaEngine(resolved.engine as SherpaEngineOptions));
}
