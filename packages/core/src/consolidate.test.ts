import { describe, expect, it } from "vitest";
import {
  applyEnrichment,
  buildBatch,
  consolidateEvents,
  selectForConsolidation,
  type ConsolidationBatch,
  type EventEnrichment
} from "./consolidate.js";
import { SherpaEventSchema, type SherpaEvent } from "./types.js";

function makeEvent(overrides: Partial<SherpaEvent> = {}): SherpaEvent {
  return SherpaEventSchema.parse({
    caseId: "test-case",
    source: "test",
    type: "message.user.inbound",
    actor: "user",
    outcome: "unknown",
    labels: [],
    meta: { preview: "hello world" },
    ...overrides
  });
}

function makeMockClassifier(enrichments: EventEnrichment[]) {
  return async (_batch: ConsolidationBatch): Promise<EventEnrichment[]> => enrichments;
}

describe("consolidate", () => {
  describe("buildBatch", () => {
    it("extracts preview from meta", () => {
      const event = makeEvent({ meta: { preview: "test preview" } });
      const batch = buildBatch([event]);
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]!.preview).toBe("test preview");
    });

    it("handles missing preview gracefully", () => {
      const event = makeEvent({ meta: {} });
      const batch = buildBatch([event]);
      expect(batch.events[0]!.preview).toBe("");
    });
  });

  describe("applyEnrichment", () => {
    it("updates type and adds classification labels", () => {
      const event = makeEvent({ type: "message.user.inbound", labels: ["existing"] });
      const enrichment: EventEnrichment = {
        eventId: event.eventId,
        enrichedType: "message.user.command",
        intent: "command",
        domain: "code",
        sessionShape: "execution",
        feedbackSignal: null,
        confidence: 0.95
      };

      const result = applyEnrichment(event, enrichment, "test-model");

      expect(result.type).toBe("message.user.command");
      expect(result.labels).toContain("existing");
      expect(result.labels).toContain("intent:command");
      expect(result.labels).toContain("domain:code");
      expect(result.labels).toContain("session-shape:execution");
      expect(result.labels).not.toContain("feedback:null");
      expect((result.meta as Record<string, unknown>).consolidated).toBe(true);
      expect((result.meta as Record<string, unknown>).originalType).toBe("message.user.inbound");
      expect((result.meta as Record<string, unknown>).consolidationModel).toBe("test-model");
    });

    it("preserves originalType on re-consolidation", () => {
      const event = makeEvent({
        type: "message.user.command",
        meta: { originalType: "message.user.inbound", consolidated: true }
      });
      const enrichment: EventEnrichment = {
        eventId: event.eventId,
        enrichedType: "message.user.question",
        intent: "question",
        domain: "research",
        sessionShape: "exploration",
        feedbackSignal: null,
        confidence: 0.88
      };

      const result = applyEnrichment(event, enrichment, "v2-model");

      expect(result.type).toBe("message.user.question");
      expect((result.meta as Record<string, unknown>).originalType).toBe("message.user.inbound");
    });

    it("adds feedback label when present", () => {
      const event = makeEvent();
      const enrichment: EventEnrichment = {
        eventId: event.eventId,
        enrichedType: "message.user.correction",
        intent: "correction",
        domain: "code",
        sessionShape: "debugging",
        feedbackSignal: "corrected",
        confidence: 0.9
      };

      const result = applyEnrichment(event, enrichment, "test");
      expect(result.labels).toContain("feedback:corrected");
    });
  });

  describe("selectForConsolidation", () => {
    it("filters out already-consolidated events", () => {
      const consolidated = makeEvent({ meta: { consolidated: true } });
      const unconsolidated = makeEvent({ meta: {} });

      const result = selectForConsolidation([consolidated, unconsolidated], false);
      expect(result).toHaveLength(1);
      expect(result[0]!.eventId).toBe(unconsolidated.eventId);
    });

    it("includes all events when reclassify is true", () => {
      const consolidated = makeEvent({ meta: { consolidated: true } });
      const unconsolidated = makeEvent({ meta: {} });

      const result = selectForConsolidation([consolidated, unconsolidated], true);
      expect(result).toHaveLength(2);
    });
  });

  describe("consolidateEvents", () => {
    it("enriches unconsolidated events via classify function", async () => {
      const event = makeEvent({ type: "message.user.inbound" });

      const classify = makeMockClassifier([
        {
          eventId: event.eventId,
          enrichedType: "message.user.command.code",
          intent: "command",
          domain: "code",
          sessionShape: "execution",
          feedbackSignal: null,
          confidence: 0.92
        }
      ]);

      const { events, result } = await consolidateEvents([event], {
        classify,
        model: "mock"
      });

      expect(result.enriched).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
      expect(events[0]!.type).toBe("message.user.command.code");
    });

    it("skips events with zero confidence", async () => {
      const event = makeEvent();

      const classify = makeMockClassifier([
        {
          eventId: event.eventId,
          enrichedType: "message.user.unknown",
          intent: "unknown",
          domain: "unknown",
          sessionShape: "unknown",
          feedbackSignal: null,
          confidence: 0
        }
      ]);

      const { result } = await consolidateEvents([event], {
        classify,
        model: "mock"
      });

      expect(result.enriched).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("does not modify events in dry-run mode", async () => {
      const event = makeEvent({ type: "message.user.inbound" });

      const classify = makeMockClassifier([
        {
          eventId: event.eventId,
          enrichedType: "message.user.command",
          intent: "command",
          domain: "code",
          sessionShape: "execution",
          feedbackSignal: null,
          confidence: 0.9
        }
      ]);

      const { events, result } = await consolidateEvents([event], {
        classify,
        model: "mock",
        dryRun: true
      });

      expect(result.enriched).toBe(1);
      expect(events[0]!.type).toBe("message.user.inbound"); // unchanged
    });

    it("handles classify errors gracefully", async () => {
      const event = makeEvent();

      const classify = async () => {
        throw new Error("API down");
      };

      const { result } = await consolidateEvents([event], {
        classify,
        model: "mock"
      });

      expect(result.errors).toBe(1);
      expect(result.enriched).toBe(0);
    });

    it("batches events according to batchSize", async () => {
      const events = Array.from({ length: 7 }, () => makeEvent());
      let callCount = 0;

      const classify = async (batch: ConsolidationBatch) => {
        callCount++;
        return batch.events.map((e) => ({
          eventId: e.eventId,
          enrichedType: "message.user.command",
          intent: "command" as const,
          domain: "code" as const,
          sessionShape: "execution" as const,
          feedbackSignal: null,
          confidence: 0.9
        }));
      };

      await consolidateEvents(events, {
        classify,
        model: "mock",
        batchSize: 3
      });

      expect(callCount).toBe(3); // 3 + 3 + 1
    });
  });
});
