import { describe, expect, it } from "vitest";

import { formatMcpJsonResult, resolveSherpaMcpOptions } from "./server.js";

describe("resolveSherpaMcpOptions", () => {
  it("parses stdio server flags", () => {
    expect(
      resolveSherpaMcpOptions([
        "--root",
        "/tmp/sherpa",
        "--agent-id",
        "alpha",
        "--default-order",
        "4",
        "--min-support",
        "2"
      ])
    ).toEqual({
      rootDir: "/tmp/sherpa",
      agentId: "alpha",
      defaultOrder: 4,
      minSupport: 2
    });
  });
});

describe("formatMcpJsonResult", () => {
  it("returns text and structured content", () => {
    const result = formatMcpJsonResult({
      backend: "sherpa",
      healthy: true
    });

    expect(result.structuredContent).toEqual({
      result: {
        backend: "sherpa",
        healthy: true
      }
    });
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("\"backend\": \"sherpa\"");
  });
});
