import type { SherpaStateStrategy } from "@sherpa/core";

import { compareBaselineDatasetFile, type ValidationBaselineComparisonReport, type ValidationBaselineName } from "./baselines.js";
import {
  compareDatasetFile,
  type ValidationComparisonReport,
  type ValidationDatasetLoadOptions
} from "./validate.js";

export type ResearchClaimId = "H1" | "H2" | "H3" | "H4" | "H5";
export type ResearchClaimDecision = "supported" | "rejected" | "pending";

export interface ResearchGateClaim {
  id: ResearchClaimId;
  claim: string;
  decision: ResearchClaimDecision;
  evidence: string;
  nextAction: string;
}

export interface ResearchGateReport {
  dataset: string;
  generatedAt: string;
  sherpa: ValidationComparisonReport;
  baselines: ValidationBaselineComparisonReport;
  claims: ResearchGateClaim[];
}

function findStrategy(report: ValidationComparisonReport, strategy: SherpaStateStrategy) {
  return report.strategies.find((entry) => entry.stateStrategy === strategy) ?? null;
}

function findBaseline(report: ValidationBaselineComparisonReport, baseline: ValidationBaselineName) {
  return report.baselines.find((entry) => entry.baseline === baseline) ?? null;
}

function formatRatio(value: number | null | undefined) {
  return typeof value === "number" ? value.toFixed(3) : "n/a";
}

export function decideResearchClaims(params: {
  sherpa: ValidationComparisonReport;
  baselines: ValidationBaselineComparisonReport;
}): ResearchGateClaim[] {
  const raw = findStrategy(params.sherpa, "raw");
  const procedure = findStrategy(params.sherpa, "procedure");
  const familyProcedure = findStrategy(params.sherpa, "family-procedure");
  const globalMajority = findBaseline(params.baselines, "global-majority");
  const bestBaseline = params.baselines.bestByAccuracy
    ? findBaseline(params.baselines, params.baselines.bestByAccuracy.baseline)
    : null;
  const bestSherpa = params.sherpa.bestByAccuracy
    ? findStrategy(params.sherpa, params.sherpa.bestByAccuracy.stateStrategy)
    : null;
  const rawBeatsMajority =
    raw && globalMajority
      ? raw.nextTopKAccuracy > globalMajority.nextTopKAccuracy || raw.nextTop1Accuracy > globalMajority.nextTop1Accuracy
      : false;
  const familyCompetitiveWithRaw =
    raw && familyProcedure
      ? familyProcedure.nextTopKAccuracy >= raw.nextTopKAccuracy && familyProcedure.nextTop1Accuracy >= raw.nextTop1Accuracy
      : false;
  const graphBeatsBestBaseline =
    bestSherpa && bestBaseline
      ? bestSherpa.nextTopKAccuracy > bestBaseline.nextTopKAccuracy ||
        bestSherpa.nextTop1Accuracy > bestBaseline.nextTop1Accuracy
      : false;
  const hasRiskEvidence = params.sherpa.strategies.some((entry) => entry.research.risks.expectedRiskCount > 0);
  const bestRiskRecall = params.sherpa.bestByRiskRecall?.recall ?? null;

  return [
    {
      id: "H1",
      claim: "Raw procedural recurrence exists.",
      decision: raw && globalMajority ? (rawBeatsMajority ? "supported" : "rejected") : "pending",
      evidence:
        raw && globalMajority
          ? `raw top-k=${formatRatio(raw.nextTopKAccuracy)}, global-majority top-k=${formatRatio(globalMajority.nextTopKAccuracy)}`
          : "raw and global-majority reports are required",
      nextAction: rawBeatsMajority
        ? "Keep raw suffix as a serious baseline for every iteration."
        : "Investigate whether next-step prediction is too weak; shift attention to risk/intervention metrics if this persists."
    },
    {
      id: "H2",
      claim: "Semantic procedural abstraction improves or preserves generalization over raw suffixes.",
      decision: raw && familyProcedure ? (familyCompetitiveWithRaw ? "supported" : "rejected") : "pending",
      evidence:
        raw && familyProcedure
          ? `raw top-1/top-k=${formatRatio(raw.nextTop1Accuracy)}/${formatRatio(raw.nextTopKAccuracy)}, family-procedure top-1/top-k=${formatRatio(familyProcedure.nextTop1Accuracy)}/${formatRatio(familyProcedure.nextTopKAccuracy)}`
          : "raw and family-procedure reports are required",
      nextAction: familyCompetitiveWithRaw
        ? "Continue testing whether abstraction improves risk, explanation, or support density."
        : "Demote more semantic detail to reranking/explanation or use raw as the primary predictive path."
    },
    {
      id: "H3",
      claim: "Structured graph memory beats non-Sherpa sequence baselines under the current offline objective.",
      decision: bestSherpa && bestBaseline ? (graphBeatsBestBaseline ? "supported" : "rejected") : "pending",
      evidence:
        bestSherpa && bestBaseline
          ? `best Sherpa=${bestSherpa.stateStrategy} top-k=${formatRatio(bestSherpa.nextTopKAccuracy)}, best baseline=${bestBaseline.baseline} top-k=${formatRatio(bestBaseline.nextTopKAccuracy)}`
          : "Sherpa and baseline comparisons are required",
      nextAction: graphBeatsBestBaseline
        ? "Add stronger semantic RAG, textual lesson, and long-context baselines."
        : "Treat current graph retrieval as unproven; compare against stronger and weaker baselines before making claims."
    },
    {
      id: "H4",
      claim: "Sparse advice improves behavior without meaningful harm.",
      decision: hasRiskEvidence && bestRiskRecall !== null && bestRiskRecall > 0 ? "pending" : "pending",
      evidence: hasRiskEvidence
        ? `offline annotated risk recall=${formatRatio(bestRiskRecall)}; sandbox intervention evidence still required`
        : "no annotated risk or sandbox intervention evidence in this report",
      nextAction: "Run Docker sandbox suites in shadow and advisory modes, then compare task outcomes, harm, and advice counts."
    },
    {
      id: "H5",
      claim: "Procedural memory transfers across repos, task families, agents, or frameworks.",
      decision: "pending",
      evidence: `procedure top-k=${procedure ? formatRatio(procedure.nextTopKAccuracy) : "n/a"}; cross-domain held-out splits are not yet evaluated`,
      nextAction: "Add explicit cross-family and cross-repo splits before making transfer claims."
    }
  ];
}

export async function runResearchGate(
  datasetPath: string,
  options: ValidationDatasetLoadOptions & {
    strategies: SherpaStateStrategy[];
    baselines: ValidationBaselineName[];
    rootParent?: string;
    defaultOrder?: number;
    minOrder?: number;
    maxOrder?: number;
    minSupport?: number;
    topK?: number;
    maxMisses?: number;
    baselineOrder?: number;
  }
): Promise<ResearchGateReport> {
  const sherpa = await compareDatasetFile(datasetPath, {
    ...options,
    strategies: options.strategies
  });
  const baselineOrder = options.baselineOrder ?? options.maxOrder ?? options.defaultOrder;
  const baselines = await compareBaselineDatasetFile(datasetPath, {
    ...options,
    baselines: options.baselines,
    ...(baselineOrder !== undefined ? { order: baselineOrder } : {})
  });

  return {
    dataset: datasetPath,
    generatedAt: new Date().toISOString(),
    sherpa,
    baselines,
    claims: decideResearchClaims({
      sherpa,
      baselines
    })
  };
}
