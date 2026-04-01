import type { SherpaEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Consolidation types
// ---------------------------------------------------------------------------

export type UserIntent =
  | "command"
  | "question"
  | "correction"
  | "followup"
  | "escalation"
  | "approval"
  | "abandonment"
  | "pivot"
  | "unknown";

export type Domain =
  | "config"
  | "debug"
  | "refactor"
  | "research"
  | "ops"
  | "test"
  | "communication"
  | "creative"
  | "unknown";

export type Sentiment =
  | "positive"
  | "neutral"
  | "negative"
  | "frustrated"
  | "unknown";

export interface ClassifyResult {
  eventId: string;
  enrichedType: string;
  intent: UserIntent;
  domain: Domain;
  sentiment: Sentiment;
  confidence: number;
}

export type EventEnrichment = ClassifyResult;

export interface ConsolidationBatch {
  events: Array<{
    eventId: string;
    type: string;
    source: string;
    actor: string;
    labels: string[];
    preview: string;
    caseId: string;
    ts: string;
    context?: SherpaEvent["context"];
  }>;
}

export interface ConsolidationResult {
  totalEvents: number;
  unconsolidated: number;
  enriched: number;
  skipped: number;
  errors: number;
  model: string;
  durationMs: number;
}

export interface ConsolidateOptions {
  /** LLM classification function — injected by caller */
  classify: (batch: ConsolidationBatch) => Promise<ClassifyResult[]>;
  /** Events per LLM call (default: 50) */
  batchSize?: number;
  /** Preview enrichments without writing (default: false) */
  dryRun?: boolean;
  /** Re-process already-consolidated events (default: false) */
  reclassify?: boolean;
  /** Trigger rebuild() after consolidation (default: true) */
  rebuild?: boolean;
  /** Model name for metadata tracking */
  model?: string;
  /** Progress callback */
  onProgress?: (processed: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// Consolidation prompt
// ---------------------------------------------------------------------------

export const CONSOLIDATION_SYSTEM_PROMPT = `You are a workflow event classifier for an AI agent's procedural memory system.

You will receive a batch of events from agent sessions. For each event, classify it along these dimensions:

1. **enrichedType** — A more specific event type:
   - User messages: \`message.user.{intent}\` (e.g., \`message.user.command\`, \`message.user.correction\`, \`message.user.pivot\`)
   - Tool events: \`{family}.{toolName}.{phase}\` (e.g., \`tool.read.started\`, \`web.web_search.succeeded\`)
   - For tool events, extract the tool name from labels (format: \`tool:{name}\`)
   - Keep session/task events bounded and operational

2. **intent** vocabulary:
   - command
   - question
   - correction
   - followup
   - escalation
   - approval
   - abandonment
   - pivot
   - unknown

3. **domain** vocabulary:
   - config
   - debug
   - refactor
   - research
   - ops
   - test
   - communication
   - creative
   - unknown

4. **sentiment** vocabulary:
   - positive
   - neutral
   - negative
   - frustrated
   - unknown

5. **confidence**: 0.0-1.0, your confidence in the classification

Use \`context.text\` when present as the primary classification signal. \`context.preceding\` and \`context.toolArgs\` are supplemental hints.

Respond with JSON only:
{
  "enrichments": [
    {
      "eventId": "...",
      "enrichedType": "...",
      "intent": "...",
      "domain": "...",
      "sentiment": "...",
      "confidence": 0.92
    }
  ]
}

Rules:
- Classify EVERY event in the batch — one enrichment per eventId
- For tool events, the enrichedType should include the actual tool name from labels
- For non-user events, set intent to \`unknown\` unless the event itself clearly encodes a user response
- Be conservative with confidence — if context is insufficient, use lower confidence and \`unknown\` labels where needed
- Prefer more specific enriched types when the available context supports them`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPreview(event: SherpaEvent): string {
  const meta = event.meta as Record<string, unknown>;
  if (typeof meta.preview === "string") {
    return meta.preview;
  }
  return "";
}

function isConsolidated(event: SherpaEvent): boolean {
  const meta = event.meta as Record<string, unknown>;
  return meta.consolidated === true;
}

export function buildBatch(events: SherpaEvent[]): ConsolidationBatch {
  return {
    events: events.map((event) => ({
      eventId: event.eventId,
      type: event.type,
      source: event.source,
      actor: event.actor,
      labels: event.labels,
      preview: getPreview(event),
      caseId: event.caseId,
      ts: event.ts,
      ...(event.context ? { context: event.context } : {})
    }))
  };
}

export function applyEnrichment(event: SherpaEvent, enrichment: EventEnrichment, model: string): SherpaEvent {
  const meta = event.meta as Record<string, unknown>;

  return {
    ...event,
    type: enrichment.enrichedType,
    labels: [
      ...event.labels,
      ...(enrichment.intent !== "unknown" ? [`intent:${enrichment.intent}`] : []),
      ...(enrichment.domain !== "unknown" ? [`domain:${enrichment.domain}`] : []),
      ...(enrichment.sentiment !== "unknown" ? [`sentiment:${enrichment.sentiment}`] : [])
    ],
    meta: {
      ...meta,
      originalType: meta.originalType ?? event.type,
      consolidated: true,
      consolidatedAt: new Date().toISOString(),
      consolidationModel: model,
      consolidationConfidence: enrichment.confidence,
      consolidationIntent: enrichment.intent,
      consolidationDomain: enrichment.domain,
      consolidationSentiment: enrichment.sentiment
    }
  };
}

export function selectForConsolidation(
  events: SherpaEvent[],
  reclassify: boolean
): SherpaEvent[] {
  if (reclassify) {
    return events;
  }
  return events.filter((event) => !isConsolidated(event));
}

/**
 * Run consolidation on a set of events.
 * Returns the full event list with enrichments applied (caller handles persistence).
 */
export async function consolidateEvents(
  allEvents: SherpaEvent[],
  options: ConsolidateOptions
): Promise<{ events: SherpaEvent[]; result: ConsolidationResult }> {
  const startTime = Date.now();
  const batchSize = options.batchSize ?? 50;
  const model = options.model ?? "unknown";
  const reclassify = options.reclassify ?? false;

  const targets = selectForConsolidation(allEvents, reclassify);
  const eventMap = new Map(allEvents.map((event) => [event.eventId, event]));

  let enriched = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < targets.length; i += batchSize) {
    const batchEvents = targets.slice(i, i + batchSize);
    const batch = buildBatch(batchEvents);

    try {
      const enrichments = await options.classify(batch);
      const enrichmentMap = new Map(enrichments.map((e) => [e.eventId, e]));

      for (const event of batchEvents) {
        const enrichment = enrichmentMap.get(event.eventId);
        if (enrichment && enrichment.confidence > 0) {
          const enrichedEvent = applyEnrichment(event, enrichment, model);
          if (!options.dryRun) {
            eventMap.set(event.eventId, enrichedEvent);
          }
          enriched++;
        } else {
          skipped++;
        }
      }
    } catch {
      errors += batchEvents.length;
    }

    options.onProgress?.(Math.min(i + batchSize, targets.length), targets.length);
  }

  return {
    events: [...eventMap.values()].sort((a, b) => {
      if (a.caseId !== b.caseId) return a.caseId.localeCompare(b.caseId);
      if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
      return a.eventId.localeCompare(b.eventId);
    }),
    result: {
      totalEvents: allEvents.length,
      unconsolidated: targets.length,
      enriched,
      skipped,
      errors,
      model,
      durationMs: Date.now() - startTime
    }
  };
}
