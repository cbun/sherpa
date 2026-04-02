/**
 * Ingest N OpenClaw session log files into a Sherpa root for consolidation testing.
 */
import path from "node:path";
import { parseSessionLog, findSessionFiles } from "../packages/cli/src/session-parser.js";
import { mapSessionToSherpaEvents } from "../packages/cli/src/session-mapper.js";
import { SherpaEngine } from "../packages/core/src/engine.js";

async function main() {
  const root = process.argv[2] ?? "/tmp/sherpa-ingest-test";
  const maxSessions = parseInt(process.argv[3] ?? "10", 10);
  const sessionsDir = process.argv[4] ?? path.join(process.env.HOME ?? "~", ".openclaw/agents/main/sessions");

  const files = await findSessionFiles(sessionsDir);
  const selected = files.slice(0, maxSessions);

  console.log(`Ingesting ${selected.length} sessions into ${root}`);

  const engine = new SherpaEngine({ rootDir: root });
  await engine.init();

  let totalEvents = 0;
  for (const f of selected) {
    try {
      const parsed = await parseSessionLog(f);
      const events = mapSessionToSherpaEvents(parsed);
      if (events.length === 0) continue;
      await engine.ingestBatch(events);
      totalEvents += events.length;
      console.log(`  ${path.basename(f)}: ${events.length} events`);
    } catch (e: any) {
      console.error(`  ${path.basename(f)}: SKIP (${e.message})`);
    }
  }

  const status = await engine.status();
  console.log(`\nDone: ${totalEvents} events ingested, ${status.totalCases} cases`);
  console.log(`Graph: ${status.stateCount} states`);
}

main().catch(console.error);
