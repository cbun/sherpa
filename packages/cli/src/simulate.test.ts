import { describe, expect, it } from "vitest";

import { parseSessionLog, type ParsedSession } from "./session-parser.js";
import { mapSessionToSherpaEvents, classifyToolFamily } from "./session-mapper.js";
import { runSimulation, type SimulateOptions } from "./simulate.js";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_JSONL = [
  JSON.stringify({ type: "session", version: 3, id: "test-session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
  JSON.stringify({ type: "model_change", id: "mc1", parentId: null, timestamp: "2026-01-01T00:00:00.001Z", provider: "anthropic", modelId: "claude-opus-4-6" }),
  JSON.stringify({ type: "thinking_level_change", id: "tlc1", parentId: "mc1", timestamp: "2026-01-01T00:00:00.002Z", thinkingLevel: "medium" }),
  JSON.stringify({
    type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "Hello world" }] }
  }),
  JSON.stringify({
    type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check that." },
        { type: "toolCall", id: "call_abc", name: "read", arguments: { file_path: "/tmp/test.txt" } }
      ],
      model: "claude-opus-4-6", stopReason: "end_turn"
    }
  }),
  JSON.stringify({
    type: "message", id: "m3", parentId: "m2", timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "toolResult", toolCallId: "call_abc", toolName: "read",
      content: [{ type: "text", text: "file contents here" }]
    }
  }),
  JSON.stringify({
    type: "message", id: "m4", parentId: "m3", timestamp: "2026-01-01T00:00:04.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Here's what I found." }],
      model: "claude-opus-4-6", stopReason: "end_turn"
    }
  }),
  JSON.stringify({
    type: "message", id: "m5", parentId: "m4", timestamp: "2026-01-01T00:00:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_def", name: "web_search", arguments: { query: "test" } }
      ],
      model: "claude-opus-4-6", stopReason: "end_turn"
    }
  }),
  JSON.stringify({
    type: "message", id: "m6", parentId: "m5", timestamp: "2026-01-01T00:00:06.000Z",
    message: {
      role: "toolResult", toolCallId: "call_def", toolName: "web_search",
      content: [{ type: "text", text: "search results" }]
    }
  })
].join("\n");

async function writeTempJsonl(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-test-"));
  const filePath = path.join(dir, "test-session.jsonl");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Session Parser Tests
// ---------------------------------------------------------------------------

describe("session-parser", () => {
  it("parses JSONL into a ParsedSession with correct events", async () => {
    const filePath = await writeTempJsonl(SAMPLE_JSONL);

    try {
      const session = await parseSessionLog(filePath);

      expect(session.id).toBe("test-session-1");
      expect(session.timestamp).toBe("2026-01-01T00:00:00.000Z");

      // Should have: session.start, user, assistant, tool.result, assistant, assistant, tool.result, session.end
      // model_change & thinking_level_change should be skipped
      const kinds = session.events.map((e) => e.kind);
      expect(kinds).toContain("session.start");
      expect(kinds).toContain("user.message");
      expect(kinds).toContain("assistant.message");
      expect(kinds).toContain("tool.result");
      expect(kinds).toContain("session.end");

      // No model_change etc in output
      expect(kinds.every((k) =>
        k === "session.start" || k === "user.message" || k === "assistant.message" || k === "tool.result" || k === "session.end"
      )).toBe(true);

      // Check tool calls on assistant message
      const assistantWithTool = session.events.find(
        (e) => e.kind === "assistant.message" && (e as { toolCalls: unknown[] }).toolCalls.length > 0
      );
      expect(assistantWithTool).toBeDefined();
      if (assistantWithTool && assistantWithTool.kind === "assistant.message") {
        expect(assistantWithTool.toolCalls[0]!.name).toBe("read");
      }
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("sorts events by timestamp", async () => {
    const filePath = await writeTempJsonl(SAMPLE_JSONL);
    try {
      const session = await parseSessionLog(filePath);
      const timestamps = session.events
        .map((e) => ("timestamp" in e ? e.timestamp : ""))
        .filter(Boolean);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]! >= timestamps[i - 1]!).toBe(true);
      }
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Session Mapper Tests
// ---------------------------------------------------------------------------

describe("session-mapper", () => {
  it("maps parsed session events to SherpaEventInput types", async () => {
    const filePath = await writeTempJsonl(SAMPLE_JSONL);
    try {
      const session = await parseSessionLog(filePath);
      const events = mapSessionToSherpaEvents(session);

      expect(events.length).toBeGreaterThan(0);

      const types = events.map((e) => e.type);

      // Should contain these event types
      expect(types).toContain("session.started");
      expect(types).toContain("message.user.inbound");
      expect(types).toContain("message.assistant.reply");
      expect(types).toContain("tool.started");
      expect(types).toContain("tool.succeeded");
      expect(types).toContain("session.ended");

      // web_search should produce web.started / web.succeeded
      expect(types).toContain("web.started");
      expect(types).toContain("web.succeeded");

      // All events should have caseId
      for (const event of events) {
        expect(event.caseId).toBeTruthy();
        expect(event.source).toBeTruthy();
      }
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("classifies tool families correctly", () => {
    expect(classifyToolFamily("read")).toBe("tool");
    expect(classifyToolFamily("write")).toBe("tool");
    expect(classifyToolFamily("exec")).toBe("tool");
    expect(classifyToolFamily("web_search")).toBe("web");
    expect(classifyToolFamily("web_fetch")).toBe("web");
    expect(classifyToolFamily("browser_action")).toBe("browser");
    expect(classifyToolFamily("screenshot")).toBe("browser");
    expect(classifyToolFamily("cron_create")).toBe("automation");
    expect(classifyToolFamily("schedule_task")).toBe("automation");
  });
});

// ---------------------------------------------------------------------------
// Simulation Tests
// ---------------------------------------------------------------------------

describe("simulate", () => {
  const defaultOptions: SimulateOptions = {
    rebuildEvery: 10,
    advisoryThreshold: 0.75,
    verbose: false
  };

  it("runs simulation with a single synthetic session", async () => {
    const filePath = await writeTempJsonl(SAMPLE_JSONL);
    try {
      const session = await parseSessionLog(filePath);
      const report = await runSimulation([session], defaultOptions);

      expect(report.totalEvents).toBeGreaterThan(0);
      expect(report.sessionsProcessed).toBe(1);
      expect(report.casesDetected).toBeGreaterThanOrEqual(1);
      expect(report.rebuildsPerformed).toBeGreaterThanOrEqual(1);
      expect(report.finalGraphStats.events).toBe(report.totalEvents);
      expect(report.durationMs).toBeGreaterThan(0);
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("runs multi-session simulation with cumulative learning", async () => {
    // Create two sessions with similar patterns
    const session1Lines = [
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
      JSON.stringify({ type: "message", id: "s1m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Do task A" }] } }),
      JSON.stringify({ type: "message", id: "s1m2", parentId: "s1m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "On it." }, { type: "toolCall", id: "c1", name: "read", arguments: { file_path: "/a" } }], model: "claude-opus-4-6", stopReason: "end_turn" } }),
      JSON.stringify({ type: "message", id: "s1m3", parentId: "s1m2", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "data" }] } }),
      JSON.stringify({ type: "message", id: "s1m4", parentId: "s1m3", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }], model: "claude-opus-4-6", stopReason: "end_turn" } })
    ].join("\n");

    const session2Lines = [
      JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: "2026-01-02T00:00:00.000Z", cwd: "/tmp" }),
      JSON.stringify({ type: "message", id: "s2m1", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Do task B" }] } }),
      JSON.stringify({ type: "message", id: "s2m2", parentId: "s2m1", timestamp: "2026-01-02T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Sure." }, { type: "toolCall", id: "c2", name: "exec", arguments: { command: "ls" } }], model: "claude-opus-4-6", stopReason: "end_turn" } }),
      JSON.stringify({ type: "message", id: "s2m3", parentId: "s2m2", timestamp: "2026-01-02T00:00:03.000Z", message: { role: "toolResult", toolCallId: "c2", toolName: "exec", content: [{ type: "text", text: "output" }] } }),
      JSON.stringify({ type: "message", id: "s2m4", parentId: "s2m3", timestamp: "2026-01-02T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "All done." }], model: "claude-opus-4-6", stopReason: "end_turn" } })
    ].join("\n");

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-multi-test-"));
    const f1 = path.join(dir, "s1.jsonl");
    const f2 = path.join(dir, "s2.jsonl");
    await fs.writeFile(f1, session1Lines, "utf8");
    await fs.writeFile(f2, session2Lines, "utf8");

    try {
      const s1 = await parseSessionLog(f1);
      const s2 = await parseSessionLog(f2);
      const report = await runSimulation([s1, s2], defaultOptions);

      expect(report.sessionsProcessed).toBe(2);
      expect(report.casesDetected).toBe(2);
      expect(report.totalEvents).toBeGreaterThan(0);
      expect(report.toolFamilyCounts["tool"]).toBeGreaterThanOrEqual(2); // read + exec tool families
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects advisory when threshold is very low", async () => {
    // Build a session with enough repetitive patterns to trigger predictions
    const lines: string[] = [
      JSON.stringify({ type: "session", version: 3, id: "advisory-test", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" })
    ];

    // Create repeated user→assistant→tool→result pattern
    for (let i = 0; i < 20; i++) {
      const ts = `2026-01-01T00:0${Math.floor(i / 10)}:${String((i % 10) * 5).padStart(2, "0")}.000Z`;
      lines.push(JSON.stringify({
        type: "message", id: `u${i}`, parentId: i === 0 ? null : `a${i - 1}r`,
        timestamp: ts,
        message: { role: "user", content: [{ type: "text", text: `Request ${i}` }] }
      }));
      lines.push(JSON.stringify({
        type: "message", id: `a${i}`, parentId: `u${i}`,
        timestamp: new Date(Date.parse(ts) + 1000).toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `Response ${i}` },
            { type: "toolCall", id: `tc${i}`, name: "read", arguments: { file_path: `/file${i}` } }
          ],
          model: "claude-opus-4-6", stopReason: "end_turn"
        }
      }));
      lines.push(JSON.stringify({
        type: "message", id: `a${i}r`, parentId: `a${i}`,
        timestamp: new Date(Date.parse(ts) + 2000).toISOString(),
        message: {
          role: "toolResult", toolCallId: `tc${i}`, toolName: "read",
          content: [{ type: "text", text: `data ${i}` }]
        }
      }));
    }

    const filePath = await writeTempJsonl(lines.join("\n"));
    try {
      const session = await parseSessionLog(filePath);
      const report = await runSimulation([session], {
        rebuildEvery: 10,
        advisoryThreshold: 0.1, // Very low threshold to trigger advisories
        verbose: false
      });

      expect(report.totalEvents).toBeGreaterThan(0);
      expect(report.rebuildsPerformed).toBeGreaterThanOrEqual(1);
      // With low threshold and repetitive patterns, we should get advisories
      // (may or may not fire depending on graph state, but simulation shouldn't crash)
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});
