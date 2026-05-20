import { z } from "zod";

import {
  SHERPA_ARTIFACT_CLASSES,
  SHERPA_BLOCKER_TYPES,
  SHERPA_INTENTS,
  SHERPA_OPERATIONS,
  SHERPA_TASK_CLASSES
} from "./ontology.js";

const OutcomeSchema = z.enum(["success", "failure", "unknown"]);
const ProjectionSourceSchema = z.enum(["llm", "manual", "imported"]);
const TaskClassSchema = z.enum(SHERPA_TASK_CLASSES);
const IntentSchema = z.enum(SHERPA_INTENTS);
const OperationSchema = z.enum(SHERPA_OPERATIONS);
const ArtifactClassSchema = z.enum(SHERPA_ARTIFACT_CLASSES);
const BlockerTypeSchema = z.enum(SHERPA_BLOCKER_TYPES);
const SherpaEventContextSchema = z
  .object({
    text: z.string().max(500).optional(),
    preceding: z.string().max(200).optional(),
    toolArgs: z.string().max(300).optional()
  })
  .optional();

export const SherpaEventProjectionSchema = z.object({
  version: z.string().min(1),
  source: ProjectionSourceSchema,
  confidence: z.number().min(0).max(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  promptVersion: z.string().min(1).optional(),
  taskClass: TaskClassSchema.optional(),
  intent: IntentSchema.optional(),
  operation: OperationSchema.optional(),
  artifactClass: ArtifactClassSchema.optional(),
  blockerType: BlockerTypeSchema.optional(),
  entityRoles: z.array(z.string()).default([])
});

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
  projection: SherpaEventProjectionSchema.optional(),
  metrics: z.record(z.string(), z.number()).default({}),
  meta: z.record(z.string(), z.unknown()).default({}),
  context: SherpaEventContextSchema
});

export type SherpaEvent = z.infer<typeof SherpaEventSchema>;
export type SherpaEventInput = z.input<typeof SherpaEventSchema>;
export type SherpaOutcome = z.infer<typeof OutcomeSchema>;
export type SherpaEventProjection = z.infer<typeof SherpaEventProjectionSchema>;
export type SherpaProjectionSource = z.infer<typeof ProjectionSourceSchema>;
export type WorkflowRecallMode = "successful" | "failed" | "any";
export type SherpaStateStrategy = "raw" | "procedure" | "family-procedure";

export interface WorkflowMatchEvidence {
  mode: "projected" | "raw";
  description: string;
  matchedOrder: number;
  facetFields: string[];
  state: string[];
  stateKey: string;
}

export interface WorkflowSemanticDescriptor {
  taskClass?: SherpaEventProjection["taskClass"];
  operation?: SherpaEventProjection["operation"];
  artifactClass?: SherpaEventProjection["artifactClass"];
  blockerType?: SherpaEventProjection["blockerType"];
}

export interface SherpaEngineOptions {
  rootDir: string;
  defaultOrder?: number;
  minOrder?: number;
  maxOrder?: number;
  minSupport?: number;
  stateStrategy?: SherpaStateStrategy;
  requireProjection?: boolean;
  allowRawFallback?: boolean;
  allowedProjectionSources?: SherpaProjectionSource[];
}

export interface WorkflowStateResult {
  caseId: string;
  state: string[];
  matchedWorkflow: string | null;
  matchedOrder: number;
  confidence: number;
  support: number;
  matchedBy?: WorkflowMatchEvidence | null;
  recentEvents: SherpaEvent[];
}

export interface WorkflowNextCandidate {
  event: string;
  semanticEvent?: string | null;
  semanticProjection?: WorkflowSemanticDescriptor | null;
  probability: number;
  support: number;
  successRate: number | null;
  failureRate: number | null;
  meanTimeToNextMs: number | null;
  userResponseDist?: Record<string, number>;
  matchedOrder: number;
  score: number;
  reason: string;
}

export interface WorkflowNextResult {
  caseId: string;
  state: string[];
  match?: WorkflowMatchEvidence | null;
  candidates: WorkflowNextCandidate[];
}

export interface WorkflowRisk {
  branch: string;
  semanticBranch?: string | null;
  semanticProjection?: WorkflowSemanticDescriptor | null;
  kind: "stall" | "failure";
  probability: number;
  relativeRisk: number;
  support: number;
  matchedOrder: number;
  confidence: number;
  score: number;
  suggestedIntervention: string;
}

export interface Signal {
  state: string[];
  prediction: string;
  probability: number;
  support: number;
  userResponseDist: Record<string, number>;
  basis: Array<{
    caseId: string;
    context?: string;
  }>;
}

export interface WorkflowSignalsResult {
  caseId: string;
  state: string[];
  signals: Signal[];
}

export interface WorkflowRisksResult {
  caseId: string;
  state: string[];
  match?: WorkflowMatchEvidence | null;
  risks: WorkflowRisk[];
}

export interface WorkflowRecallPath {
  caseId: string;
  distance: number;
  outcome: SherpaOutcome;
  matchedOrder: number;
  confidence: number;
  score: number;
  matchedBy?: WorkflowMatchEvidence;
  continuation: string[];
  continuationSemantic?: string[];
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
    stateStrategy: SherpaStateStrategy;
    requireProjection: boolean;
    allowRawFallback: boolean;
    allowedProjectionSources: SherpaProjectionSource[];
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

export interface ImportResult {
  importedAt: string;
  eventCount: number;
  caseCount: number;
  fromExportedAt: string | null;
}

export interface SherpaMetrics {
  // Adoption
  totalEvents: number;
  totalCases: number;
  activeCasesLast7d: number;

  // Quality
  advisoryInjections: number;

  // Efficiency
  meanCaseDurationMs: number | null;

  // Reliability
  rebuildCount: number;
  lastRebuildAt: string | null;
  ledgerCorruptionCount: number;
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
