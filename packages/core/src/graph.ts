import type { SherpaEvent } from "./types.js";

export function stateKeyFromEvents(eventTypes: string[]) {
  return eventTypes.join(" -> ");
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

    caseRows.push({
      caseId,
      agentId: ordered[0]?.agentId ?? "main",
      eventCount: ordered.length,
      firstSeenAt: ordered[0]?.ts ?? new Date(0).toISOString(),
      lastSeenAt: ordered.at(-1)?.ts ?? new Date(0).toISOString()
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
          lastSeenAt: nextEvent.ts
        };

        current.support += 1;
        current.lastSeenAt = nextEvent.ts > current.lastSeenAt ? nextEvent.ts : current.lastSeenAt;

        if (nextEvent.outcome === "success") {
          current.successCount += 1;
        } else if (nextEvent.outcome === "failure") {
          current.failureCount += 1;
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
