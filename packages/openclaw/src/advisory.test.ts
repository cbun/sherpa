import { describe, expect, it } from "vitest";

import { buildSherpaAdvisory } from "./advisory.js";
import { resolveSherpaPluginConfig } from "./config.js";

describe("buildSherpaAdvisory", () => {
  it("returns a bounded advisory when confidence is strong enough", () => {
    const config = resolveSherpaPluginConfig(
      {
        advisory: {
          enabled: true,
          injectThreshold: 0.7,
          maxCandidates: 2,
          maxRisks: 1,
          maxChars: 500
        }
      },
      { agentId: "alpha" }
    );

    const advisory = buildSherpaAdvisory({
      config,
      state: {
        caseId: "session:agent:alpha:telegram:direct:user-1",
        state: ["docs.requested", "docs.received", "review.started"],
        matchedWorkflow: "workflow:vendor-review",
        matchedOrder: 3,
        confidence: 0.82,
        support: 6,
        recentEvents: []
      },
      next: {
        caseId: "session:agent:alpha:telegram:direct:user-1",
        state: ["docs.requested", "docs.received", "review.started"],
        candidates: [
          {
            event: "approval.needed",
            probability: 0.58,
            support: 4,
            successRate: 0.8,
            meanTimeToNextMs: 60000,
            matchedOrder: 3,
            reason: "Matched 3-event suffix"
          },
          {
            event: "issue.found",
            probability: 0.23,
            support: 2,
            successRate: 0.3,
            meanTimeToNextMs: 120000,
            matchedOrder: 3,
            reason: "Matched 3-event suffix"
          }
        ]
      },
      risks: {
        caseId: "session:agent:alpha:telegram:direct:user-1",
        state: ["docs.requested", "docs.received", "review.started"],
        risks: [
          {
            branch: "missing.attachment",
            kind: "stall",
            probability: 0.2,
            relativeRisk: 2.1,
            support: 2,
            matchedOrder: 3,
            suggestedIntervention: "verify attachment completeness before continuing"
          }
        ]
      }
    });

    expect(advisory).toContain("Sherpa advisory");
    expect(advisory).toContain("approval.needed (58%)");
    expect(advisory).toContain("missing.attachment branch has high stall risk");
  });

  it("skips weak advisories", () => {
    const config = resolveSherpaPluginConfig(
      {
        advisory: {
          enabled: true,
          injectThreshold: 0.9
        }
      },
      { agentId: "alpha" }
    );

    const advisory = buildSherpaAdvisory({
      config,
      state: {
        caseId: "session:agent:alpha:telegram:direct:user-1",
        state: ["review.started"],
        matchedWorkflow: null,
        matchedOrder: 1,
        confidence: 0.6,
        support: 1,
        recentEvents: []
      },
      next: {
        caseId: "session:agent:alpha:telegram:direct:user-1",
        state: ["review.started"],
        candidates: []
      },
      risks: {
        caseId: "session:agent:alpha:telegram:direct:user-1",
        state: ["review.started"],
        risks: []
      }
    });

    expect(advisory).toBeNull();
  });
});
