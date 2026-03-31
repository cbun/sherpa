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
      slug: "vendor-review",
      reason: "explicit"
    });

    expect(
      router.resolveActiveCaseId({
        policy,
        sessionKey: "agent:alpha:telegram:direct:user-1"
      })
    ).toBe("session:agent:alpha:telegram:direct:user-1:task:vendor-review:1234");
  });

  it("starts an automatic task case on the first meaningful message", () => {
    const config = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });
    const router = new SherpaCaseRouter(config);
    const policy = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:direct:user-1"
    });

    const dispatch = router.routeDispatch({
      policy,
      sessionKey: "agent:alpha:telegram:direct:user-1",
      content: "Please investigate the deployment error in production.",
      timestamp: 2000
    });

    expect(dispatch.boundary).toMatchObject({
      title: "Please investigate the deployment error in production",
      reason: "auto-first-message"
    });
    expect(dispatch.boundary?.caseId).toBe(
      "session:agent:alpha:telegram:direct:user-1:task:please-investigate-the-deployment-error-in-produ:2000"
    );
    expect(dispatch.boundary?.slug).toBe("please-investigate-the-deployment-error-in-produ");
    expect(dispatch.caseId).toBe(dispatch.boundary?.caseId);
  });

  it("rotates to a new automatic case after an idle timeout", () => {
    const config = resolveSherpaPluginConfig(
      {
        caseSplitting: {
          auto: {
            idleTimeout: "5m",
            minContentChars: 12
          }
        }
      },
      { agentId: "alpha" }
    );
    const router = new SherpaCaseRouter(config);
    const policy = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:direct:user-1"
    });

    router.routeDispatch({
      policy,
      sessionKey: "agent:alpha:telegram:direct:user-1",
      content: "Investigate deployment error",
      timestamp: 1_000
    });

    const dispatch = router.routeDispatch({
      policy,
      sessionKey: "agent:alpha:telegram:direct:user-1",
      content: "Now summarize the customer impact for leadership.",
      timestamp: 1_000 + 300_000
    });

    expect(dispatch.boundary).toMatchObject({
      reason: "auto-idle-timeout",
      title: "Now summarize the customer impact for leadership"
    });
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

  it("ignores automatic splitting for short inbound messages", () => {
    const config = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });
    const router = new SherpaCaseRouter(config);
    const policy = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:direct:user-1"
    });

    const dispatch = router.routeDispatch({
      policy,
      sessionKey: "agent:alpha:telegram:direct:user-1",
      content: "help",
      timestamp: 2000
    });

    expect(dispatch.boundary).toBeNull();
    expect(dispatch.caseId).toBeNull();
  });
});
