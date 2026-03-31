import { z } from "zod";

const OutcomeSchema = z.enum(["success", "failure", "unknown"]);

export const SherpaEventSchema = z.object({
  eventId: z.string().min(1).default(() => crypto.randomUUID()),
  schemaVersion: z.literal(1).default(1),
  agentId: z.string().min(1).default("main"),
  caseId: z.string().min(1),
  ts: z.string().datetime().default(() => new Date().toISOString()),
  source: z.string().min(1),
  type: z.string().min(1),
  actor: z.string().min(1).default("agent"),
  outcome: OutcomeSchema.default("unknown"),
  labels: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  metrics: z.record(z.string(), z.number()).default({}),
  meta: z.record(z.string(), z.unknown()).default({})
});

export type SherpaEvent = z.infer<typeof SherpaEventSchema>;
export type SherpaEventInput = z.input<typeof SherpaEventSchema>;
export type SherpaOutcome = z.infer<typeof OutcomeSchema>;
export type WorkflowRecallMode = "successful" | "failed" | "any";

export interface SherpaEngineOptions {
  rootDir: string;
  defaultOrder?: number;
  minOrder?: number;
  maxOrder?: number;
  minSupport?: number;
}

export interface WorkflowStateResult {
  caseId: string;
  state: string[];
  matchedWorkflow: string | null;
  matchedOrder: number;
  confidence: number;
  support: number;
  recentEvents: SherpaEvent[];
}

export interface WorkflowNextCandidate {
  event: string;
  probability: number;
  support: number;
  successRate: number | null;
  failureRate: number | null;
  meanTimeToNextMs: number | null;
  matchedOrder: number;
  score: number;
  reason: string;
}

export interface WorkflowNextResult {
  caseId: string;
  state: string[];
  candidates: WorkflowNextCandidate[];
}

export interface WorkflowRisk {
  branch: string;
  kind: "stall" | "failure";
  probability: number;
  relativeRisk: number;
  support: number;
  matchedOrder: number;
  confidence: number;
  score: number;
  suggestedIntervention: string;
}

export interface WorkflowRisksResult {
  caseId: string;
  state: string[];
  risks: WorkflowRisk[];
}

export interface WorkflowRecallPath {
  caseId: string;
  distance: number;
  outcome: SherpaOutcome;
  matchedOrder: number;
  confidence: number;
  score: number;
  continuation: string[];
}

export interface WorkflowRecallResult {
  caseId: string;
  state: string[];
  mode: WorkflowRecallMode;
  paths: WorkflowRecallPath[];
}

export interface WorkflowStatusResult {
  backend: "sherpa";
  healthy: boolean;
  events: number;
  cases: number;
  states: number;
  lastUpdateAt: string | null;
  lastRebuildAt: string | null;
  ledgerFreshness: {
    healthy: boolean;
    latestEventAt: string | null;
    ageMs: number | null;
  };
  graphFreshness: {
    healthy: boolean;
    rebuiltAt: string | null;
    ageMs: number | null;
  };
  advisoryEnabled: boolean;
  config: {
    defaultOrder: number;
    minOrder: number;
    maxOrder: number;
    minSupport: number;
  };
  ledgerPath: string;
  graphPath: string;
}

export interface TaxonomyReportOptions {
  recentDays?: number;
  rareSupport?: number;
  limit?: number;
  asOf?: string;
}

export interface TaxonomyTypeSummary {
  event: string;
  count: number;
  share: number;
  firstSeenAt: string;
  lastSeenAt: string;
  baselineCount: number;
  baselineShare: number | null;
  recentCount: number;
  recentShare: number | null;
  isNewInRecentWindow: boolean;
  isRare: boolean;
}

export interface TaxonomyDriftMetrics {
  recentWindowDays: number;
  recentWindowStart: string;
  baselineEventCount: number;
  baselineDistinctTypes: number;
  recentEventCount: number;
  recentDistinctTypes: number;
  newTypeCount: number;
  newTypeShare: number;
  rareTypeCount: number;
  rareEventShare: number;
  score: number;
}

export interface TaxonomyReportResult {
  generatedAt: string;
  totalEvents: number;
  distinctTypes: number;
  rareSupport: number;
  topTypes: TaxonomyTypeSummary[];
  rareTypes: TaxonomyTypeSummary[];
  recentNewTypes: TaxonomyTypeSummary[];
  drift: TaxonomyDriftMetrics;
}

export interface AnalyticsReportOptions {
  limit?: number;
  asOf?: string;
}

export interface AnalyticsTransition {
  order: number;
  state: string[];
  nextEvent: string;
  support: number;
  successRate: number | null;
  failureRate: number | null;
  stallRate: number | null;
  meanTimeToNextMs: number | null;
  lastSeenAt: string;
}

export interface AnalyticsReportResult {
  generatedAt: string;
  cases: {
    total: number;
    success: number;
    failure: number;
    unknown: number;
    successRate: number;
    failureRate: number;
  };
  hotTransitions: AnalyticsTransition[];
  failureBranches: AnalyticsTransition[];
  stallBranches: AnalyticsTransition[];
}

export interface ExportResult {
  exportPath: string;
  exportedAt: string;
  eventCount: number;
  caseCount: number;
  stateCount: number;
}

export interface GcResult {
  vacuumed: boolean;
  removedTmpFiles: number;
  removedExportFiles: number;
}

export interface DoctorResult {
  healthy: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    details: string;
  }>;
}
