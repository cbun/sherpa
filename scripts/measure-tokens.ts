/**
 * Measure token usage for consolidating a single session.
 */
import { parseSessionLog } from "../packages/cli/src/session-parser.js";
import { mapSessionToSherpaEvents } from "../packages/cli/src/session-mapper.js";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: pnpm exec tsx scripts/measure-tokens.ts <session.jsonl>");
    process.exit(1);
  }

  const parsed = await parseSessionLog(file);
  const events = mapSessionToSherpaEvents(parsed);

  console.log(`Session: ${parsed.sessionId ?? file.split("/").pop()}`);
  console.log(`Parsed events: ${events.length}`);
  console.log(`Event types: ${[...new Set(events.map(e => e.type))].join(", ")}`);

  // Simulate classifier prompt construction (batches of 20)
  const BATCH_SIZE = 20;
  const batches = Math.ceil(events.length / BATCH_SIZE);
  
  const systemPrompt = `You are a classifier for procedural workflow events in an AI agent system.
For each event, determine:
1. intent: The user/system intent (e.g., "code_review", "web_research", "file_edit", "conversation", "task_planning")
2. domain: The domain area (e.g., "development", "research", "communication", "devops", "data_analysis")
3. refinedType: A more specific event type (e.g., "tool.git.succeeded", "message.user.command", "tool.web.search.succeeded")
4. sentiment: "positive", "negative", or "neutral"
5. confidence: 0.0-1.0

Return a JSON array of objects with fields: index, intent, domain, refinedType, sentiment, confidence`;

  let totalInputChars = 0;

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const batchText = batch.map((ev, idx) => {
      const ctx = ev.context ? ` | context: ${JSON.stringify(ev.context)}` : "";
      return `${idx + 1}. id=${ev.id} type=${ev.type} case=${ev.caseId}${ctx}`;
    }).join("\n");
    const userPrompt = `Classify these ${batch.length} events:\n\n${batchText}`;
    totalInputChars += systemPrompt.length + userPrompt.length;
  }

  // Tokens (~3.5 chars/token for mixed content)
  const inputTokens = Math.ceil(totalInputChars / 3.5);
  // Output: ~35 tokens per event classification JSON object
  const outputTokens = Math.ceil(events.length * 35);
  const total = inputTokens + outputTokens;

  console.log(`\n--- Token Estimates ---`);
  console.log(`LLM calls: ${batches} (${BATCH_SIZE} events/batch)`);
  console.log(`Input: ~${inputTokens.toLocaleString()} tokens`);
  console.log(`Output: ~${outputTokens.toLocaleString()} tokens`);
  console.log(`Total: ~${total.toLocaleString()} tokens`);

  const models = [
    { name: "GPT-4o-mini",      inp: 0.15,  out: 0.60 },
    { name: "Haiku 3.5",        inp: 0.80,  out: 4.00 },
    { name: "Sonnet 4",         inp: 3.00,  out: 15.00 },
    { name: "GPT-4o",           inp: 2.50,  out: 10.00 },
  ];

  console.log(`\n--- Cost (this session) ---`);
  for (const m of models) {
    const c = (inputTokens / 1e6 * m.inp) + (outputTokens / 1e6 * m.out);
    console.log(`  ${m.name.padEnd(14)} $${c.toFixed(4)}`);
  }

  console.log(`\n--- Scaled to 168 sessions ---`);
  for (const m of models) {
    const c = ((inputTokens / 1e6 * m.inp) + (outputTokens / 1e6 * m.out)) * 168;
    console.log(`  ${m.name.padEnd(14)} $${c.toFixed(2)}`);
  }

  // Context field analysis
  let withCtx = 0, ctxChars = 0;
  for (const ev of events) {
    if (ev.context) { withCtx++; ctxChars += JSON.stringify(ev.context).length; }
  }
  console.log(`\n--- Context ---`);
  console.log(`Events with context: ${withCtx}/${events.length}`);
  if (withCtx) console.log(`Avg context size: ${Math.round(ctxChars / withCtx)} chars`);
}

main().catch(console.error);
