import type { SherpaEvent, SherpaEventProjection, SherpaStateStrategy } from "./types.js";

export const SHERPA_PROCEDURE_ATOMS = [
  "request",
  "start",
  "lookup",
  "inspect",
  "read",
  "edit",
  "write",
  "test",
  "search",
  "navigate",
  "approve",
  "capture",
  "manage",
  "execute",
  "answer",
  "wait",
  "complete",
  "fail"
] as const;

export type SherpaProcedureAtom = (typeof SHERPA_PROCEDURE_ATOMS)[number];
export type SherpaStateDimension = "family" | "procedure";

export interface SherpaDerivedContext {
  operation?: SherpaEventProjection["operation"];
  artifactClass?: SherpaEventProjection["artifactClass"];
  blockerType?: SherpaEventProjection["blockerType"];
  entityRoles: string[];
}

export interface SherpaDerivedEventState {
  family: SherpaEventProjection["taskClass"] | null;
  procedure: SherpaProcedureAtom | null;
  context: SherpaDerivedContext;
}

const SHERPA_STATE_DIMENSION_LEVELS: readonly (readonly SherpaStateDimension[])[] = [
  ["family", "procedure"],
  ["procedure"],
  []
] as const;

export function stateDimensionsForStrategy(
  strategy: SherpaStateStrategy
): readonly (readonly SherpaStateDimension[])[] {
  switch (strategy) {
    case "raw":
      return [[]] as const;
    case "procedure":
      return [["procedure"], []] as const;
    case "family-procedure":
      return SHERPA_STATE_DIMENSION_LEVELS;
    default:
      return SHERPA_STATE_DIMENSION_LEVELS;
  }
}

function procedureFromOperation(
  operation: SherpaEventProjection["operation"] | undefined
): SherpaProcedureAtom | null {
  switch (operation) {
    case "message-received":
      return "request";
    case "message-sent":
      return "answer";
    case "task-start":
    case "tool-start":
      return "start";
    case "task-completed":
      return "complete";
    case "task-failed":
      return "fail";
    case "task-ended":
      return "wait";
    case "repo-inspect-start":
    case "repo-inspect":
    case "logs-inspect-start":
    case "logs-inspect":
    case "env-check-start":
    case "env-check":
      return "inspect";
    case "file-read-start":
    case "file-read":
    case "web-fetch":
      return "read";
    case "file-edit-start":
    case "file-edit":
    case "docs-edit-start":
    case "docs-edit":
      return "edit";
    case "file-write-start":
    case "file-write":
      return "write";
    case "tests-run-start":
    case "tests-run":
      return "test";
    case "web-search":
    case "memory-search-start":
    case "memory-search":
      return "search";
    case "browser-navigate":
      return "navigate";
    case "approval-start":
    case "approval":
      return "approve";
    case "capture-screenshot":
    case "image-analyze-start":
    case "image-analyze":
      return "capture";
    case "automation-run":
    case "process-manage-start":
    case "process-manage":
    case "session-manage-start":
    case "session-manage":
    case "subagent-manage-start":
    case "subagent-manage":
      return "manage";
    case "deploy-start":
    case "deploy":
    case "tool-run":
      return "execute";
    default:
      return null;
  }
}

function procedureFromSemanticContext(
  projection: SherpaEventProjection | undefined
): SherpaProcedureAtom | null {
  if (!projection) {
    return null;
  }

  if (
    projection.operation === "message-received" &&
    (projection.intent === "research" || projection.taskClass === "research") &&
    (projection.artifactClass === "docs" ||
      projection.artifactClass === "knowledge" ||
      projection.artifactClass === "web")
  ) {
    return "lookup";
  }

  return null;
}

function procedureFromRawType(type: string): SherpaProcedureAtom | null {
  if (type === "task.completed" || type.endsWith(".completed")) {
    return "complete";
  }

  if (type === "task.failed" || type.endsWith(".failed")) {
    return "fail";
  }

  if (type.endsWith(".started")) {
    return "start";
  }

  if (type.endsWith(".received") || type.endsWith(".requested")) {
    return "request";
  }

  return null;
}

function dominantTaskClass(
  counts: Map<NonNullable<SherpaEventProjection["taskClass"]>, { count: number; firstSeen: number }>
) {
  const entries = [...counts.entries()];
  if (entries.length === 0) {
    return null;
  }

  const specificEntries = entries.filter(([taskClass]) => taskClass !== "general-task");
  const pool = specificEntries.length > 0 ? specificEntries : entries;
  pool.sort((left, right) => {
    if (right[1].count !== left[1].count) {
      return right[1].count - left[1].count;
    }

    if (left[1].firstSeen !== right[1].firstSeen) {
      return left[1].firstSeen - right[1].firstSeen;
    }

    return left[0].localeCompare(right[0]);
  });

  const winner = pool[0]?.[0] ?? null;
  return winner === "general-task" ? null : winner;
}

function normalizedFamily(taskClass: SherpaEventProjection["taskClass"] | null | undefined) {
  return taskClass && taskClass !== "general-task" ? taskClass : null;
}

function deriveEventStateWithFamily(
  event: Pick<SherpaEvent, "type" | "projection">,
  family: SherpaEventProjection["taskClass"] | null
): SherpaDerivedEventState {
  const projection = event.projection;

  return {
    family,
    procedure:
      procedureFromSemanticContext(projection) ??
      procedureFromOperation(projection?.operation) ??
      procedureFromRawType(event.type),
    context: {
      ...(projection?.operation ? { operation: projection.operation } : {}),
      ...(projection?.artifactClass ? { artifactClass: projection.artifactClass } : {}),
      ...(projection?.blockerType ? { blockerType: projection.blockerType } : {}),
      entityRoles: projection?.entityRoles ?? []
    }
  };
}

export function deriveSequenceProjectionStates(
  events: ReadonlyArray<Pick<SherpaEvent, "type" | "projection">>
): SherpaDerivedEventState[] {
  const counts = new Map<NonNullable<SherpaEventProjection["taskClass"]>, { count: number; firstSeen: number }>();

  return events.map((event, index) => {
    const taskClass = event.projection?.taskClass;
    if (taskClass) {
      const current = counts.get(taskClass);
      counts.set(taskClass, {
        count: (current?.count ?? 0) + 1,
        firstSeen: current?.firstSeen ?? index
      });
    }

    return deriveEventStateWithFamily(event, dominantTaskClass(counts));
  });
}

export function deriveEventProjectionState(
  event: Pick<SherpaEvent, "type" | "projection">
): SherpaDerivedEventState {
  return deriveEventStateWithFamily(event, normalizedFamily(event.projection?.taskClass));
}
