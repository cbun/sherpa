import { describe, expect, it } from "vitest";

import { SherpaCaseRouter } from "./cases.js";
import { resolveSherpaPluginConfig } from "./config.js";
import { resolveSherpaPolicyDecision } from "./policy.js";

describe("SherpaCaseRouter", () => {
  it("starts and reuses explicit task-boundary cases within a session", () => {
    const config = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });
    const router = new SherpaCaseRouter(config);
    const policy = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:direct:user-1"
    });

    const boundary = router.startTaskBoundary({
      policy,
      sessionKey: "agent:alpha:telegram:direct:user-1",
      content: "/task Vendor review",
      timestamp: 1234
    });

    expect(boundary).toMatchObject({
      caseId: "session:agent:alpha:telegram:direct:user-1:task:vendor-review:1234",
      title: "Vendor review",
      slug: "vendor-review"
    });

    expect(
      router.resolveActiveCaseId({
        policy,
        sessionKey: "agent:alpha:telegram:direct:user-1"
      })
    ).toBe("session:agent:alpha:telegram:direct:user-1:task:vendor-review:1234");
  });

  it("does not open explicit cases when case splitting is disabled", () => {
    const config = resolveSherpaPluginConfig(
      {
        caseSplitting: {
          enabled: false
        }
      },
      { agentId: "alpha" }
    );
    const router = new SherpaCaseRouter(config);
    const policy = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:direct:user-1"
    });

    expect(
      router.startTaskBoundary({
        policy,
        sessionKey: "agent:alpha:telegram:direct:user-1",
        content: "/task Vendor review",
        timestamp: 1234
      })
    ).toBeNull();
  });
});
