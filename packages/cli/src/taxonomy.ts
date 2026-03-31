import type { TaxonomyReportResult } from "@sherpa/core";

export interface TaxonomyThresholds {
  maxTypes?: number;
  maxNewTypeShare?: number;
  maxRareEventShare?: number;
  maxDriftScore?: number;
}

export function assertTaxonomyThresholds(report: TaxonomyReportResult, thresholds?: TaxonomyThresholds) {
  if (!thresholds) {
    return;
  }

  if (typeof thresholds.maxTypes === "number" && report.distinctTypes > thresholds.maxTypes) {
    throw new Error(
      `Taxonomy distinct type count ${report.distinctTypes} exceeds allowed maximum ${thresholds.maxTypes}`
    );
  }

  if (
    typeof thresholds.maxNewTypeShare === "number" &&
    report.drift.newTypeShare > thresholds.maxNewTypeShare
  ) {
    throw new Error(
      `Taxonomy new-type share ${report.drift.newTypeShare.toFixed(3)} exceeds allowed maximum ${thresholds.maxNewTypeShare.toFixed(3)}`
    );
  }

  if (
    typeof thresholds.maxRareEventShare === "number" &&
    report.drift.rareEventShare > thresholds.maxRareEventShare
  ) {
    throw new Error(
      `Taxonomy rare-event share ${report.drift.rareEventShare.toFixed(3)} exceeds allowed maximum ${thresholds.maxRareEventShare.toFixed(3)}`
    );
  }

  if (typeof thresholds.maxDriftScore === "number" && report.drift.score > thresholds.maxDriftScore) {
    throw new Error(
      `Taxonomy drift score ${report.drift.score.toFixed(3)} exceeds allowed maximum ${thresholds.maxDriftScore.toFixed(3)}`
    );
  }
}
