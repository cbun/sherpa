import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SherpaEngine, type SherpaEventInput } from "@sherpa/core";

import { parseSessionLog, findSessionFiles, type ParsedSession } from "./session-parser.js";
import { mapSessionToSherpaEvents } from "./session-mapper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulateOptions {
  rebuildEvery: number;
  advisoryThreshold: number;
  verbose: boolean;
  rootParent?: string;
}

export interface AdvisoryExample {
  caseId: string;
  eventIndex: number;
  eventType: string;
  topCandidate: string;
  confidence: number;
}

export interface SimulationReport {
  totalEvents: number;
  sessionsProcessed: number;
  casesDetected: number;
  rebuildsPerformed: number;
  advisoryFireCount: number;
  advisoryExamples: AdvisoryExample[];
  toolFamilyCounts: Record<string, number>;
  predictionHits: number;
  predictionAttempts: number;
  predictionAccuracy: number;
  finalGraphStats: {
    events: number;
    cases: number;
    states: number;
  };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export async function runSimulation(
  sessions: ParsedSession[],
  options: SimulateOptions
): Promise<SimulationReport> {
  const startTime = Date.now();
  const tempParent = options.rootParent ?? os.tmpdir();
  await fs.mkdir(tempParent, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(tempParent, "sherpa-simulate-"));

  const engine = new SherpaEngine({ rootDir: tempRoot });
  await engine.init();

  let totalEvents = 0;
  let rebuildsPerformed = 0;
  let advisoryFireCount = 0;
  const advisoryExamples: AdvisoryExample[] = [];
  const toolFamilyCounts: Record<string, number> = {};
  let predictionHits = 0;
  let predictionAttempts = 0;

  // Track last workflowNext candidates per caseId
  const lastPredictions = new Map<string, string[]>();

  // Accumulate events between rebuilds
  let pendingBatch: SherpaEventInput[] = [];

  for (const session of sessions) {
    const sherpaEvents = mapSessionToSherpaEvents(session);

    if (options.verbose) {
      process.stderr.write(`\n── Session ${session.id} (${sherpaEvents.length} events) ──\n`);
    }

    for (const event of sherpaEvents) {
      // Count tool families
      for (const label of event.labels ?? []) {
        if (label.startsWith("tool-family:")) {
          const family = label.slice("tool-family:".length);
          toolFamilyCounts[family] = (toolFamilyCounts[family] ?? 0) + 1;
        }
      }

      // Check prediction accuracy against prior candidates
      const caseId = event.caseId ?? "";
      const priorCandidates = lastPredictions.get(caseId);
      if (priorCandidates && priorCandidates.length > 0) {
        predictionAttempts += 1;
        if (priorCandidates.includes(event.type)) {
          predictionHits += 1;
        }
      }

      pendingBatch.push(event);
      totalEvents += 1;

      if (options.verbose && totalEvents % 100 === 0) {
        process.stderr.write(`  ingested ${totalEvents} events...\n`);
      }

      // Periodic rebuild via ingestBatch
      if (pendingBatch.length >= options.rebuildEvery) {
        await engine.ingestBatch(pendingBatch);
        rebuildsPerformed += 1;
        pendingBatch = [];

        // Query workflow state after rebuild
        if (caseId) {
          try {
            const next = await engine.workflowNext(caseId, 5);
            const candidates = next.candidates.map((c) => c.event);
            lastPredictions.set(caseId, candidates);

            // Check advisory threshold
            const topCandidate = next.candidates[0];
            if (topCandidate && topCandidate.probability >= options.advisoryThreshold) {
              advisoryFireCount += 1;
              if (advisoryExamples.length < 10) {
                advisoryExamples.push({
                  caseId,
                  eventIndex: totalEvents,
                  eventType: event.type,
                  topCandidate: topCandidate.event,
                  confidence: topCandidate.probability
                });
              }
            }

            // Also check risks
            const risks = await engine.workflowRisks(caseId, 3);
            if (risks.risks.length > 0 && options.verbose) {
              process.stderr.write(
                `  ⚠ ${risks.risks.length} risk(s) detected at event ${totalEvents}\n`
              );
            }
          } catch {
            // Workflow queries can fail if insufficient data — that's fine
          }
        }
      }
    }
  }

  // Flush remaining events
  if (pendingBatch.length > 0) {
    await engine.ingestBatch(pendingBatch);
    rebuildsPerformed += 1;
    pendingBatch = [];
  }

  // Final stats
  const status = await engine.status();

  // Cleanup
  await fs.rm(tempRoot, { recursive: true, force: true });

  return {
    totalEvents,
    sessionsProcessed: sessions.length,
    casesDetected: status.cases,
    rebuildsPerformed,
    advisoryFireCount,
    advisoryExamples,
    toolFamilyCounts,
    predictionHits,
    predictionAttempts,
    predictionAccuracy: predictionAttempts === 0 ? 0 : Number((predictionHits / predictionAttempts).toFixed(3)),
    finalGraphStats: {
      events: status.events,
      cases: status.cases,
      states: status.states
    },
    durationMs: Date.now() - startTime
  };
}

// ---------------------------------------------------------------------------
// CLI entry helpers
// ---------------------------------------------------------------------------

export async function loadSessions(options: {
  input?: string | undefined;
  dir?: string | undefined;
  maxSessions?: number | undefined;
}): Promise<ParsedSession[]> {
  const sessions: ParsedSession[] = [];

  if (options.input) {
    sessions.push(await parseSessionLog(options.input));
  } else if (options.dir) {
    const files = await findSessionFiles(options.dir);
    const limit = options.maxSessions ?? files.length;
    for (const file of files.slice(0, limit)) {
      try {
        sessions.push(await parseSessionLog(file));
      } catch (error) {
        process.stderr.write(
          `Warning: skipping ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }
  }

  return sessions;
}
