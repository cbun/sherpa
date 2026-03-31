import type { WorkflowNextResult, WorkflowRisksResult, WorkflowStateResult } from "@sherpa/core";

import type { ResolvedSherpaPluginConfig } from "./config.js";

function formatProbability(value: number) {
  return `${Math.round(value * 100)}%`;
}

function trimToChars(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function buildSherpaAdvisory(params: {
  config: ResolvedSherpaPluginConfig;
  state: WorkflowStateResult;
  next: WorkflowNextResult;
  risks: WorkflowRisksResult;
}) {
  if (!params.config.advisory.enabled) {
    return null;
  }

  if (params.state.confidence < params.config.advisory.injectThreshold) {
    return null;
  }

  if (params.next.candidates.length === 0 && params.risks.risks.length === 0) {
    return null;
  }

  const lines = [
    "Sherpa advisory",
    `Current state: ${params.state.state.join(" -> ") || "unknown"}`,
    `Confidence: ${params.state.confidence.toFixed(2)}`
  ];

  const candidates = params.next.candidates.slice(0, params.config.advisory.maxCandidates);
  if (candidates.length > 0) {
    lines.push("Likely next:");
    for (const [index, candidate] of candidates.entries()) {
      lines.push(`${index + 1}. ${candidate.event} (${formatProbability(candidate.probability)})`);
    }
  }

  const risks = params.risks.risks.slice(0, params.config.advisory.maxRisks);
  if (risks.length > 0) {
    lines.push("Top risk:");
    for (const risk of risks) {
      lines.push(`- ${risk.branch} branch has high ${risk.kind} risk`);
    }

    const suggestion = risks[0]?.suggestedIntervention;
    if (suggestion) {
      lines.push("Suggested action:");
      lines.push(`- ${suggestion}`);
    }
  }

  return trimToChars(lines.join("\n"), params.config.advisory.maxChars);
}
