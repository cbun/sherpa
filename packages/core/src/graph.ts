import type { SherpaEvent } from "./types.js";

export function stateKeyFromEvents(eventTypes: string[]) {
  return eventTypes.join(" -> ");
}

const NON_TERMINAL_EVENT_SUFFIXES = [
  ".started",
  ".requested",
  ".received",
  ".needed",
  ".granted",
  ".resumed"
];

function inferTerminalOutcome(events: SherpaEvent[]): SherpaEvent["outcome"] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }

    if (event.type === "task.completed" || event.type.endsWith(".completed")) {
      return "success";
    }

    if (event.type === "task.failed" || event.type.endsWith(".failed")) {
      return "failure";
    }

    if (event.type === "task.ended") {
      return "unknown";
    }
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.outcome === "unknown" || event.type === "session.ended") {
      continue;
    }

    if (NON_TERMINAL_EVENT_SUFFIXES.some((suffix) => event.type.endsWith(suffix))) {
      continue;
    }

    return event.outcome;
  }

  return events.at(-1)?.outcome ?? "unknown";
}

export function buildDerivedRows(events: SherpaEvent[], maxOrder: number) {
  const grouped = new Map<string, SherpaEvent[]>();

  for (const event of events) {
    const current = grouped.get(event.caseId) ?? [];
    current.push(event);
    grouped.set(event.caseId, current);
  }

  const caseRows: Array<{
    caseId: string;
    agentId: string;
    eventCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    terminalOutcome: SherpaEvent["outcome"];
  }> = [];

  const edgeMap = new Map<
    string,
      {
        orderN: number;
        stateKey: string;
        nextEvent: string;
        support: number;
        successCount: number;
        failureCount: number;
        terminalSuccessCount: number;
        terminalFailureCount: number;
        terminalUnknownCount: number;
        totalDurationMs: number;
        minDurationMs: number | null;
        maxDurationMs: number | null;
        lastSeenAt: string;
      }
  >();

  for (const [caseId, caseEvents] of grouped.entries()) {
    const ordered = caseEvents.sort((left, right) => {
      if (left.ts !== right.ts) {
        return left.ts.localeCompare(right.ts);
      }

      return left.eventId.localeCompare(right.eventId);
    });

    const terminalOutcome = inferTerminalOutcome(ordered);

    caseRows.push({
      caseId,
      agentId: ordered[0]?.agentId ?? "main",
      eventCount: ordered.length,
      firstSeenAt: ordered[0]?.ts ?? new Date(0).toISOString(),
      lastSeenAt: ordered.at(-1)?.ts ?? new Date(0).toISOString(),
      terminalOutcome
    });

    for (let index = 0; index < ordered.length - 1; index += 1) {
      for (let order = 1; order <= maxOrder; order += 1) {
        const start = index - order + 1;

        if (start < 0) {
          break;
        }

        const history = ordered.slice(start, index + 1).map((event) => event.type);
        const nextEvent = ordered[index + 1];

        if (!nextEvent) {
          continue;
        }

        const key = `${order}::${stateKeyFromEvents(history)}::${nextEvent.type}`;
        const current = edgeMap.get(key) ?? {
          orderN: order,
          stateKey: stateKeyFromEvents(history),
          nextEvent: nextEvent.type,
          support: 0,
          successCount: 0,
          failureCount: 0,
          terminalSuccessCount: 0,
          terminalFailureCount: 0,
          terminalUnknownCount: 0,
          totalDurationMs: 0,
          minDurationMs: null,
          maxDurationMs: null,
          lastSeenAt: nextEvent.ts
        };
        const currentEvent = ordered[index];

        if (!currentEvent) {
          continue;
        }

        const durationMs = Math.max(0, Date.parse(nextEvent.ts) - Date.parse(currentEvent.ts));

        current.support += 1;
        current.lastSeenAt = nextEvent.ts > current.lastSeenAt ? nextEvent.ts : current.lastSeenAt;
        current.totalDurationMs += Number.isFinite(durationMs) ? durationMs : 0;
        current.minDurationMs =
          current.minDurationMs === null ? durationMs : Math.min(current.minDurationMs, durationMs);
        current.maxDurationMs =
          current.maxDurationMs === null ? durationMs : Math.max(current.maxDurationMs, durationMs);

        if (nextEvent.outcome === "success") {
          current.successCount += 1;
        } else if (nextEvent.outcome === "failure") {
          current.failureCount += 1;
        }

        if (terminalOutcome === "success") {
          current.terminalSuccessCount += 1;
        } else if (terminalOutcome === "failure") {
          current.terminalFailureCount += 1;
        } else {
          current.terminalUnknownCount += 1;
        }

        edgeMap.set(key, current);
      }
    }
  }

  return {
    caseRows,
    stateEdgeRows: [...edgeMap.values()]
  };
}
