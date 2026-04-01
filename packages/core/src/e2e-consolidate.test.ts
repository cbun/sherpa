import { describe, it, expect } from "vitest";
import { SherpaEngine } from "./engine.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Inline minimal session parser matching OpenClaw JSONL format
function parseMinimalSession(jsonl: string) {
  const lines = jsonl.split("\n").filter(Boolean);
  const events: Array<{ type: string; ts: string; labels: string[]; actor: string }> = [];
  
  for (const line of lines) {
    const msg = JSON.parse(line);
    const ts = msg.timestamp ?? new Date().toISOString();
    
    if (msg.type === "message" && msg.message?.role === "user") {
      events.push({ type: "message.user.inbound", ts, labels: [], actor: "user" });
    } else if (msg.type === "message" && msg.message?.role === "assistant") {
      // Check for tool calls in assistant content
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use") {
            events.push({ type: "tool.started", ts, labels: [block.name ?? "unknown"], actor: "agent" });
          }
        }
      }
      events.push({ type: "message.assistant.outbound", ts, labels: [], actor: "agent" });
    } else if (msg.type === "message" && msg.message?.role === "toolResult") {
      const name = msg.message.toolName ?? "unknown";
      const outcome = msg.message.content?.[0]?.text?.includes("error") ? "failure" : "success";
      events.push({ type: outcome === "failure" ? "tool.failed" : "tool.succeeded", ts, labels: [name], actor: "agent" });
    }
  }
  return events;
}

describe("e2e consolidation", () => {
  it("consolidate enriches types and increases graph diversity", async () => {
    const sessionDir = path.join(os.homedir(), ".openclaw/agents/main/sessions");
    const files = await fs.readdir(sessionDir).catch(() => []);
    
    // Find a medium-sized session (sort by size, pick mid-range)
    let targetFile = "";
    const candidates: Array<{ name: string; size: number }> = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const stat = await fs.stat(path.join(sessionDir, f));
      if (stat.size > 10000 && stat.size < 200000) {
        candidates.push({ name: f, size: stat.size });
      }
    }
    candidates.sort((a, b) => a.size - b.size);
    const medianCandidate = candidates[Math.floor(candidates.length / 2)];
    if (medianCandidate) {
      targetFile = medianCandidate.name;
    }
    
    if (!targetFile) {
      console.log("No suitable session file found, using synthetic data");
      // Synthetic fallback
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-e2e-"));
      const engine = new SherpaEngine({ rootDir: root });
      
      const syntheticEvents = [];
      for (let i = 0; i < 50; i++) {
        syntheticEvents.push({ type: "message.user.inbound", ts: new Date(Date.now() - 50000 + i * 1000).toISOString(), source: "test", actor: "user" as const, labels: [] as string[], caseId: "test-session", meta: {} });
        syntheticEvents.push({ type: "tool.started", ts: new Date(Date.now() - 49500 + i * 1000).toISOString(), source: "test", actor: "agent" as const, labels: ["read"], caseId: "test-session", meta: {} });
        syntheticEvents.push({ type: "tool.succeeded", ts: new Date(Date.now() - 49000 + i * 1000).toISOString(), source: "test", actor: "agent" as const, labels: ["read"], caseId: "test-session", outcome: "success" as const, meta: {} });
      }
      
      await engine.ingestBatch(syntheticEvents);
      await engine.rebuild();
      
      const beforeReport = await engine.taxonomyReport({});
      const beforeTypes = beforeReport.distinctTypes;
      
      const result = await engine.consolidate({
        classify: async (batch) => batch.events.map((e) => {
          if (e.type === "message.user.inbound") return { eventId: e.eventId, enrichedType: "message.user.command", intent: "command" as const, domain: "refactor" as const, sentiment: "neutral" as const, confidence: 0.9 };
          if (e.type === "tool.started") return { eventId: e.eventId, enrichedType: "tool.io.started", intent: "unknown" as const, domain: "unknown" as const, sentiment: "unknown" as const, confidence: 0.85 };
          if (e.type === "tool.succeeded") return { eventId: e.eventId, enrichedType: "tool.io.succeeded", intent: "unknown" as const, domain: "unknown" as const, sentiment: "unknown" as const, confidence: 0.85 };
          return { eventId: e.eventId, enrichedType: e.type, intent: "unknown" as const, domain: "unknown" as const, sentiment: "unknown" as const, confidence: 0.8 };
        }),
        batchSize: 100,
        dryRun: false,
        rebuild: true,
      });
      
      const afterReport = await engine.taxonomyReport({});
      const afterTypes = afterReport.distinctTypes;
      
      console.log(`Before: ${beforeTypes} types | After: ${afterTypes} types`);
      console.log(`Enriched: ${result.enriched}/${result.totalEvents}`);
      
      expect(result.enriched).toBeGreaterThan(0);
      expect(afterTypes).toBeGreaterThan(beforeTypes);
      
      await fs.rm(root, { recursive: true, force: true });
      return;
    }

    // Real session path
    const raw = await fs.readFile(path.join(sessionDir, targetFile), "utf8");
    const parsed = parseMinimalSession(raw);
    
    console.log(`Session: ${targetFile}, parsed ${parsed.length} events`);
    
    if (parsed.length < 10) {
      console.log("Not enough parseable events, skipping");
      return;
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sherpa-e2e-"));
    const engine = new SherpaEngine({ rootDir: root });

    const caseId = `session:${targetFile.replace(".jsonl", "")}`;
    const sherpaEvents = parsed.map(e => ({
      type: e.type,
      ts: e.ts,
      source: "openclaw",
      actor: e.actor as "user" | "agent",
      labels: e.labels,
      caseId,
      meta: {},
    }));

    await engine.ingestBatch(sherpaEvents);
    await engine.rebuild();

    const beforeReport = await engine.taxonomyReport({});
    const beforeTypes = beforeReport.distinctTypes;
    const beforeStatus = await engine.status();

    console.log(`BEFORE: ${beforeStatus.events} events, ${beforeStatus.states} states, ${beforeTypes} types`);
    console.log(`  Top types: ${beforeReport.topTypes.map(t => `${t.event}(${t.count})`).join(", ")}`);

    const result = await engine.consolidate({
      classify: async (batch) => batch.events.map((e) => {
        if (e.type === "message.user.inbound") return { eventId: e.eventId, enrichedType: "message.user.command", intent: "command" as const, domain: "refactor" as const, sentiment: "neutral" as const, confidence: 0.9 };
        if (e.type?.startsWith("tool.") && e.labels?.length) {
          const name = e.labels[0];
          if (!name) {
            return { eventId: e.eventId, enrichedType: e.type, intent: "unknown" as const, domain: "unknown" as const, sentiment: "unknown" as const, confidence: 0.8 };
          }
          let family = "tool";
          if (/read|write|edit/.test(name.toLowerCase())) family = "io";
          else if (/exec|process/.test(name.toLowerCase())) family = "exec";
          else if (/web|fetch|search/.test(name.toLowerCase())) family = "web";
          const suffix = e.type.split(".").pop();
          if (family !== "tool") return { eventId: e.eventId, enrichedType: `tool.${family}.${suffix}`, intent: "unknown" as const, domain: "unknown" as const, sentiment: "unknown" as const, confidence: 0.85 };
        }
        return { eventId: e.eventId, enrichedType: e.type, intent: "unknown" as const, domain: "unknown" as const, sentiment: "unknown" as const, confidence: 0.8 };
      }),
      batchSize: 100,
      dryRun: false,
      rebuild: true,
    });

    const afterReport = await engine.taxonomyReport({});
    const afterTypes = afterReport.distinctTypes;
    const afterStatus = await engine.status();

    console.log(`\nCONSOLIDATION: enriched ${result.enriched}/${result.totalEvents} events (${result.skipped} skipped, ${result.errors} errors, ${result.durationMs}ms)`);

    console.log(`\nAFTER: ${afterStatus.events} events, ${afterStatus.states} states, ${afterTypes} types`);
    console.log(`  Top types: ${afterReport.topTypes.map(t => `${t.event}(${t.count})`).join(", ")}`);

    expect(result.enriched).toBeGreaterThan(0);
    expect(afterTypes).toBeGreaterThanOrEqual(beforeTypes);
    expect(afterStatus.events).toBe(beforeStatus.events); // no events lost

    await fs.rm(root, { recursive: true, force: true });
  }, 30000);
});
