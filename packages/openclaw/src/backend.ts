import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  SherpaEngine,
  type DoctorResult,
  type ExportResult,
  type GcResult,
  type SherpaEngineOptions,
  type SherpaEvent,
  type SherpaEventInput,
  type TaxonomyReportOptions,
  type TaxonomyReportResult,
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
  taxonomyReport(options?: TaxonomyReportOptions): Promise<TaxonomyReportResult>;
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

  taxonomyReport(options?: TaxonomyReportOptions) {
    return this.engine.taxonomyReport(options);
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
type FetchLike = typeof fetch;

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
    return this.runJson<SherpaEvent>([...buildCliSharedArgs(this.resolved), "ingest"], event);
  }

  ingestBatch(events: SherpaEventInput[]) {
    return this.runJson<SherpaEvent[]>([...buildCliSharedArgs(this.resolved), "ingest-batch"], events);
  }

  async rebuild() {
    await this.runJson<WorkflowStatusResult>([...buildCliSharedArgs(this.resolved), "rebuild"]);
  }

  status() {
    return this.runJson<WorkflowStatusResult>([...buildCliSharedArgs(this.resolved), "status"]);
  }

  doctor() {
    return this.runJson<DoctorResult>([...buildCliSharedArgs(this.resolved), "doctor"]);
  }

  exportSnapshot() {
    return this.runJson<ExportResult>([...buildCliSharedArgs(this.resolved), "export"]);
  }

  gc() {
    return this.runJson<GcResult>([...buildCliSharedArgs(this.resolved), "gc"]);
  }

  taxonomyReport(options?: TaxonomyReportOptions) {
    return this.runJson<TaxonomyReportResult>([
      ...buildCliSharedArgs(this.resolved),
      "taxonomy-report",
      ...(options?.recentDays !== undefined ? ["--recent-days", String(options.recentDays)] : []),
      ...(options?.rareSupport !== undefined ? ["--rare-support", String(options.rareSupport)] : []),
      ...(options?.limit !== undefined ? ["--limit", String(options.limit)] : [])
    ]);
  }

  workflowState(caseId: string, maxOrder?: number) {
    return this.runJson<WorkflowStateResult>(
      [
        ...buildCliSharedArgs(this.resolved),
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
        ...buildCliSharedArgs(this.resolved),
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
        ...buildCliSharedArgs(this.resolved),
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
        ...buildCliSharedArgs(this.resolved),
        "workflow-recall",
        "--case-id",
        caseId,
        ...(mode !== undefined ? ["--mode", mode] : []),
        ...(limit !== undefined ? ["--limit", String(limit)] : [])
      ]
    );
  }
}

export function buildCliSharedArgs(resolved: ResolvedSherpaPluginConfig) {
  const args = [...resolved.transport.args, "--root", resolved.storeRoot];

  if (resolved.engine.defaultOrder !== undefined) {
    args.push("--default-order", String(resolved.engine.defaultOrder));
  }

  if (resolved.engine.minOrder !== undefined) {
    args.push("--min-order", String(resolved.engine.minOrder));
  }

  if (resolved.engine.maxOrder !== undefined) {
    args.push("--max-order", String(resolved.engine.maxOrder));
  }

  if (resolved.engine.minSupport !== undefined) {
    args.push("--min-support", String(resolved.engine.minSupport));
  }

  return args;
}

export class HttpSherpaBackend implements SherpaBackend {
  constructor(
    private readonly resolved: ResolvedSherpaPluginConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async call<T>(method: string, params?: unknown): Promise<T> {
    const timeoutMs = this.resolved.transport.timeoutMs;
    const response = await this.fetchImpl(new URL("/rpc", this.resolved.transport.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ method, params }),
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    });

    const payload = (await response.json()) as
      | { ok: true; result: T }
      | { ok: false; error: { message?: string } };

    if (!response.ok || !payload.ok) {
      const message = "error" in payload ? payload.error?.message : response.statusText;
      throw new Error(`Sherpa HTTP transport failed: ${message || `HTTP ${response.status}`}`);
    }

    return payload.result;
  }

  async init() {
    await this.status();
  }

  ingest(event: SherpaEventInput) {
    return this.call<SherpaEvent>("ingest", { event });
  }

  ingestBatch(events: SherpaEventInput[]) {
    return this.call<SherpaEvent[]>("ingestBatch", { events });
  }

  async rebuild() {
    await this.call<WorkflowStatusResult>("rebuild");
  }

  status() {
    return this.call<WorkflowStatusResult>("status");
  }

  doctor() {
    return this.call<DoctorResult>("doctor");
  }

  exportSnapshot() {
    return this.call<ExportResult>("exportSnapshot");
  }

  gc() {
    return this.call<GcResult>("gc");
  }

  taxonomyReport(options?: TaxonomyReportOptions) {
    return this.call<TaxonomyReportResult>("taxonomyReport", {
      ...(options?.recentDays !== undefined ? { recentDays: options.recentDays } : {}),
      ...(options?.rareSupport !== undefined ? { rareSupport: options.rareSupport } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.asOf !== undefined ? { asOf: options.asOf } : {})
    });
  }

  workflowState(caseId: string, maxOrder?: number) {
    return this.call<WorkflowStateResult>("workflowState", {
      caseId,
      ...(maxOrder !== undefined ? { maxOrder } : {})
    });
  }

  workflowNext(caseId: string, limit?: number) {
    return this.call<WorkflowNextResult>("workflowNext", {
      caseId,
      ...(limit !== undefined ? { limit } : {})
    });
  }

  workflowRisks(caseId: string, limit?: number) {
    return this.call<WorkflowRisksResult>("workflowRisks", {
      caseId,
      ...(limit !== undefined ? { limit } : {})
    });
  }

  workflowRecall(caseId: string, mode?: WorkflowRecallMode, limit?: number) {
    return this.call<WorkflowRecallResult>("workflowRecall", {
      caseId,
      ...(mode !== undefined ? { mode } : {}),
      ...(limit !== undefined ? { limit } : {})
    });
  }
}

export function backendNeedsRefresh(current: ResolvedSherpaPluginConfig, next: ResolvedSherpaPluginConfig) {
  return JSON.stringify(current.transport) !== JSON.stringify(next.transport) ||
    JSON.stringify(current.engine) !== JSON.stringify(next.engine);
}

export function createSherpaBackend(
  resolved: ResolvedSherpaPluginConfig,
  dependencies?: {
    spawnImpl?: SpawnLike;
    fetchImpl?: FetchLike;
  }
): SherpaBackend {
  if (resolved.transport.mode === "stdio") {
    return new CliSherpaBackend(resolved, dependencies?.spawnImpl);
  }

  if (resolved.transport.mode === "http") {
    return new HttpSherpaBackend(resolved, dependencies?.fetchImpl);
  }

  return new InProcessSherpaBackend(new SherpaEngine(resolved.engine as SherpaEngineOptions));
}
