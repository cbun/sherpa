import { describe, expect, it, vi } from "vitest";

import { buildFallbackAdvisory, interpretAdvisory } from "./advisory-interpreter.js";
import { resolveSherpaPluginConfig } from "./config.js";

const config = resolveSherpaPluginConfig(
  {
    advisory: {
      enabled: true,
      maxChars: 400,
      interpreterModel: "gpt-4o-mini"
    }
  },
  { agentId: "alpha" }
);

const signals = [
  {
    state: ["docs.received", "review.started"],
    prediction: "approval.needed",
    probability: 0.67,
    support: 3,
    userResponseDist: {
      approval: 2,
      correction: 1
    },
    basis: [
      {
        caseId: "case-1",
        context: "Please get approval before you send the report."
      }
    ]
  }
];

describe("advisory interpreter", () => {
  it("falls back to a template when no interpreter config is available", async () => {
    const advisory = await interpretAdvisory(
      {
        config,
        signals,
        conversation: [{ role: "user", content: "send the report once it's approved" }]
      },
      {
        resolveConfig: async () => null
      }
    );

    expect(advisory).toContain("Sherpa advisory");
    expect(advisory).toContain("approval.needed");
    expect(advisory).toContain("approval:2");
  });

  it("uses the interpreter result when an LLM is available", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  advisory: "He usually wants approval confirmed before sending the report."
                })
              }
            }
          ]
        })
      }) as Response
    );

    const advisory = await interpretAdvisory(
      {
        config,
        signals,
        conversation: [{ role: "user", content: "should I send it now?" }]
      },
      {
        fetchImpl,
        resolveConfig: async () => ({
          apiKey: "test",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          provider: "openai"
        })
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(advisory).toBe("He usually wants approval confirmed before sending the report.");
  });

  it("returns null when the interpreter suppresses the advisory", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  advisory: null
                })
              }
            }
          ]
        })
      }) as Response
    );

    const advisory = await interpretAdvisory(
      {
        config,
        signals,
        conversation: [{ role: "user", content: "continue" }]
      },
      {
        fetchImpl,
        resolveConfig: async () => ({
          apiKey: "test",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          provider: "openai"
        })
      }
    );

    expect(advisory).toBeNull();
  });

  it("builds a bounded fallback advisory from raw signals", () => {
    const advisory = buildFallbackAdvisory({
      config,
      signals
    });

    expect(advisory).toContain("Likely next: approval.needed");
    expect(advisory).toContain("Historical context");
  });
});
