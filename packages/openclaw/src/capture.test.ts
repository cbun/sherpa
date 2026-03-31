import { describe, expect, it } from "vitest";

import { buildDispatchEvent, buildSessionStartEvent, buildToolFinishEvent, classifyToolFamily } from "./capture.js";
import { resolveSherpaPluginConfig } from "./config.js";

describe("capture normalization", () => {
  it("maps dispatch hooks into bounded message events without raw text by default", () => {
    const config = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });

    const event = buildDispatchEvent(config, {
      sessionKey: "agent:alpha:telegram:direct:user-123",
      channel: "telegram",
      senderId: "user-123",
      content: "please investigate the deployment error",
      timestamp: Date.parse("2026-03-30T15:00:00.000Z")
    });

    expect(event).toMatchObject({
      agentId: "alpha",
      caseId: "session:agent:alpha:telegram:direct:user-123",
      source: "openclaw.dispatch",
      type: "message.received",
      actor: "user",
      metrics: {
        contentChars: 39
      }
    });
    expect(event?.meta).not.toHaveProperty("preview");
  });

  it("captures session resumes as distinct event types", () => {
    const config = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });

    const event = buildSessionStartEvent(config, {
      sessionId: "sess-1",
      sessionKey: "agent:alpha:main",
      resumedFrom: "sess-0"
    });

    expect(event.type).toBe("session.resumed");
    expect(event.labels).toContain("session:resumed");
  });

  it("classifies tool families and preserves bounded success and failure types", () => {
    const config = resolveSherpaPluginConfig(undefined, { agentId: "alpha" });

    const event = buildToolFinishEvent(config, {
      agentId: "alpha",
      sessionKey: "agent:alpha:main",
      toolName: "browser_navigate",
      params: {
        url: "https://example.com"
      },
      error: "navigation timeout",
      durationMs: 812
    });

    expect(classifyToolFamily("browser_navigate")).toBe("browser");
    expect(event).toMatchObject({
      source: "openclaw.browser",
      type: "browser.failed",
      outcome: "failure",
      labels: ["tool:browser_navigate", "tool-family:browser"],
      metrics: {
        paramCount: 1,
        durationMs: 812
      }
    });
  });

  it("respects capture toggles for tool families", () => {
    const config = resolveSherpaPluginConfig(
      {
        capture: {
          browser: false
        }
      },
      { agentId: "alpha" }
    );

    const event = buildToolFinishEvent(config, {
      agentId: "alpha",
      sessionKey: "agent:alpha:main",
      toolName: "browser_navigate",
      params: {
        url: "https://example.com"
      }
    });

    expect(event).toBeNull();
  });
});
