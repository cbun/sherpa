import { describe, expect, it } from "vitest";

import { assertTaxonomyThresholds } from "./taxonomy.js";

describe("taxonomy threshold gating", () => {
  it("fails when taxonomy drift exceeds configured limits", () => {
    const report = {
      generatedAt: "2026-03-31T00:00:00.000Z",
      totalEvents: 40,
      distinctTypes: 12,
      rareSupport: 2,
      topTypes: [],
      rareTypes: [],
      recentNewTypes: [],
      drift: {
        recentWindowDays: 14,
        recentWindowStart: "2026-03-17T00:00:00.000Z",
        baselineEventCount: 28,
        baselineDistinctTypes: 8,
        recentEventCount: 12,
        recentDistinctTypes: 6,
        newTypeCount: 3,
        newTypeShare: 0.25,
        rareTypeCount: 4,
        rareEventShare: 0.15,
        score: 0.31
      }
    };

    expect(() =>
      assertTaxonomyThresholds(report, {
        maxTypes: 10
      })
    ).toThrow(/distinct type count/i);

    expect(() =>
      assertTaxonomyThresholds(report, {
        maxNewTypeShare: 0.2
      })
    ).toThrow(/new-type share/i);

    expect(() =>
      assertTaxonomyThresholds(report, {
        maxRareEventShare: 0.1
      })
    ).toThrow(/rare-event share/i);

    expect(() =>
      assertTaxonomyThresholds(report, {
        maxDriftScore: 0.25
      })
    ).toThrow(/drift score/i);
  });

  it("passes when taxonomy metrics stay within configured bounds", () => {
    expect(() =>
      assertTaxonomyThresholds(
        {
          generatedAt: "2026-03-31T00:00:00.000Z",
          totalEvents: 40,
          distinctTypes: 8,
          rareSupport: 2,
          topTypes: [],
          rareTypes: [],
          recentNewTypes: [],
          drift: {
            recentWindowDays: 14,
            recentWindowStart: "2026-03-17T00:00:00.000Z",
            baselineEventCount: 28,
            baselineDistinctTypes: 8,
            recentEventCount: 12,
            recentDistinctTypes: 5,
            newTypeCount: 1,
            newTypeShare: 0.08,
            rareTypeCount: 2,
            rareEventShare: 0.05,
            score: 0.14
          }
        },
        {
          maxTypes: 10,
          maxNewTypeShare: 0.2,
          maxRareEventShare: 0.1,
          maxDriftScore: 0.25
        }
      )
    ).not.toThrow();
  });
});
