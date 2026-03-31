import { describe, expect, it } from "vitest";

import { resolveSherpaPluginConfig } from "./config.js";
import { buildStatelessCaseId, resolveSherpaPolicyDecision } from "./policy.js";

describe("resolveSherpaPolicyDecision", () => {
  it("allows direct sessions by default and denies groups", () => {
    const config = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });

    const direct = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:direct:user-1"
    });
    const group = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:group:team-room"
    });

    expect(direct).toMatchObject({
      allowed: true,
      chatType: "direct",
      reason: "scope_rule:allow"
    });
    expect(group).toMatchObject({
      allowed: false,
      chatType: "group",
      reason: "scope_default:deny"
    });
  });

  it("honors ignore and stateless session patterns", () => {
    const config = resolveSherpaPluginConfig(
      {
        ignoreSessionPatterns: ["agent:alpha:telegram:group:**"],
        statelessSessionPatterns: ["agent:alpha:telegram:direct:user-*"]
      },
      { agentId: "alpha" }
    );

    const ignored = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:group:ops"
    });
    const stateless = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:direct:user-7"
    });

    expect(ignored).toMatchObject({
      allowed: false,
      reason: "ignored_session_pattern"
    });
    expect(stateless).toMatchObject({
      allowed: true,
      stateless: true
    });
  });

  it("builds stable stateless case ids from available discriminators", () => {
    const config = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });
    const policy = resolveSherpaPolicyDecision(config, {
      sessionKey: "agent:alpha:telegram:direct:user-7"
    });

    expect(
      buildStatelessCaseId({
        policy: {
          ...policy,
          stateless: true
        },
        sessionId: "sess-42"
      })
    ).toBe("session:agent:alpha:telegram:direct:user-7:stateless:sess-42");
  });
});
