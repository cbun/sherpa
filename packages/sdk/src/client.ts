import os from "node:os";
import path from "node:path";

import {
  SherpaEngine,
  type DoctorResult,
  type ExportResult,
  type GcResult,
  type ImportResult,
  type SherpaEngineOptions,
  type SherpaEvent,
  type SherpaEventInput,
  type SherpaMetrics,
  type WorkflowNextResult,
  type WorkflowRecallMode,
  type WorkflowRecallResult,
  type WorkflowRisksResult,
  type WorkflowStateResult,
  type WorkflowStatusResult
} from "@sherpa/core";

export interface SherpaSdkAgentOptions extends Omit<Partial<SherpaEngineOptions>, "rootDir"> {
  agentId?: string;
  baseDir?: string;
}

export interface SherpaClientOptions extends SherpaEngineOptions {}

export function resolveSherpaAgentRoot(options?: SherpaSdkAgentOptions) {
  const agentId = options?.agentId ?? "main";
  const baseDir = options?.baseDir ?? path.join(os.homedir(), ".openclaw", "agents");

  return path.join(baseDir, agentId, "sherpa");
}

export class SherpaClient {
  readonly engine: SherpaEngine;

  constructor(options: SherpaClientOptions) {
    this.engine = new SherpaEngine(options);
  }

  static forAgent(options?: SherpaSdkAgentOptions) {
    return new SherpaClient({
      rootDir: resolveSherpaAgentRoot(options),
      ...(options?.defaultOrder !== undefined ? { defaultOrder: options.defaultOrder } : {}),
      ...(options?.minOrder !== undefined ? { minOrder: options.minOrder } : {}),
      ...(options?.maxOrder !== undefined ? { maxOrder: options.maxOrder } : {}),
      ...(options?.minSupport !== undefined ? { minSupport: options.minSupport } : {})
    });
  }

  get rootDir() {
    return this.engine.rootDir;
  }

  init() {
    return this.engine.init();
  }

  ingest(event: SherpaEventInput): Promise<SherpaEvent> {
    return this.engine.ingest(event);
  }

  ingestBatch(events: SherpaEventInput[]): Promise<SherpaEvent[]> {
    return this.engine.ingestBatch(events);
  }

  rebuild() {
    return this.engine.rebuild();
  }

  status(): Promise<WorkflowStatusResult> {
    return this.engine.status();
  }

  doctor(): Promise<DoctorResult> {
    return this.engine.doctor();
  }

  exportSnapshot(): Promise<ExportResult> {
    return this.engine.exportSnapshot();
  }

  importSnapshot(snapshotPath: string): Promise<ImportResult> {
    return this.engine.importSnapshot(snapshotPath);
  }

  gc(): Promise<GcResult> {
    return this.engine.gc();
  }

  collectMetrics(): Promise<SherpaMetrics> {
    return this.engine.collectMetrics();
  }

  trackAdvisoryInjection(): Promise<void> {
    return this.engine.trackAdvisoryInjection();
  }

  workflowState(caseId: string, maxOrder?: number): Promise<WorkflowStateResult> {
    return this.engine.workflowState(caseId, maxOrder);
  }

  workflowNext(caseId: string, limit?: number): Promise<WorkflowNextResult> {
    return this.engine.workflowNext(caseId, limit);
  }

  workflowRisks(caseId: string, limit?: number): Promise<WorkflowRisksResult> {
    return this.engine.workflowRisks(caseId, limit);
  }

  workflowRecall(caseId: string, mode?: WorkflowRecallMode, limit?: number): Promise<WorkflowRecallResult> {
    return this.engine.workflowRecall(caseId, mode, limit);
  }
}

export function createSherpaClient(options: SherpaClientOptions) {
  return new SherpaClient(options);
}
