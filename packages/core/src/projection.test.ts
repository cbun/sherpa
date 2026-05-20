import { describe, expect, it } from "vitest";

import { deriveEventProjectionState, deriveSequenceProjectionStates } from "./projection.js";

describe("deriveEventProjectionState", () => {
  it("derives routed family and low-cardinality procedure from the existing projection", () => {
    const derived = deriveEventProjectionState({
      type: "tool.succeeded",
      projection: {
        version: "draft-v1",
        source: "manual",
        taskClass: "code-fix",
        operation: "tests-run",
        artifactClass: "codebase",
        entityRoles: ["tool:exec", "tool-family:tool"]
      }
    });

    expect(derived).toEqual({
      family: "code-fix",
      procedure: "test",
      context: {
        operation: "tests-run",
        artifactClass: "codebase",
        entityRoles: ["tool:exec", "tool-family:tool"]
      }
    });
  });

  it("falls back to raw event type when projection is missing", () => {
    const derived = deriveEventProjectionState({
      type: "task.completed"
    });

    expect(derived).toEqual({
      family: null,
      procedure: "complete",
      context: {
        entityRoles: []
      }
    });
  });

  it("derives lookup from research-style request context", () => {
    const derived = deriveEventProjectionState({
      type: "message.received",
      projection: {
        version: "draft-v1",
        source: "llm",
        taskClass: "research",
        intent: "research",
        operation: "message-received",
        artifactClass: "docs",
        entityRoles: []
      }
    });

    expect(derived).toEqual({
      family: "research",
      procedure: "lookup",
      context: {
        operation: "message-received",
        artifactClass: "docs",
        entityRoles: []
      }
    });
  });

  it("derives answer from assistant reply events", () => {
    const derived = deriveEventProjectionState({
      type: "message.sent",
      projection: {
        version: "draft-v1",
        source: "llm",
        operation: "message-sent",
        artifactClass: "docs",
        entityRoles: []
      }
    });

    expect(derived).toEqual({
      family: null,
      procedure: "answer",
      context: {
        operation: "message-sent",
        artifactClass: "docs",
        entityRoles: []
      }
    });
  });
});

describe("deriveSequenceProjectionStates", () => {
  it("propagates the dominant case family across later events in the sequence", () => {
    const derived = deriveSequenceProjectionStates([
      {
        type: "task.started",
        projection: {
          version: "draft-v1",
          source: "llm",
          taskClass: "research",
          operation: "task-start",
          artifactClass: "docs",
          entityRoles: []
        }
      },
      {
        type: "message.received",
        projection: {
          version: "draft-v1",
          source: "llm",
          intent: "research",
          operation: "message-received",
          artifactClass: "docs",
          entityRoles: []
        }
      },
      {
        type: "tool.succeeded",
        projection: {
          version: "draft-v1",
          source: "llm",
          taskClass: "general-task",
          operation: "file-read",
          artifactClass: "docs",
          entityRoles: ["tool:read"]
        }
      }
    ]);

    expect(derived.map((event) => event.family)).toEqual(["research", "research", "research"]);
    expect(derived[2]).toMatchObject({
      procedure: "read",
      context: {
        operation: "file-read",
        artifactClass: "docs",
        entityRoles: ["tool:read"]
      }
    });
  });

  it("does not route a case family when only general-task is observed", () => {
    const derived = deriveSequenceProjectionStates([
      {
        type: "message.received",
        projection: {
          version: "draft-v1",
          source: "llm",
          taskClass: "general-task",
          operation: "message-received",
          entityRoles: []
        }
      },
      {
        type: "tool.succeeded",
        projection: {
          version: "draft-v1",
          source: "llm",
          taskClass: "general-task",
          operation: "file-read",
          artifactClass: "docs",
          entityRoles: ["tool:read"]
        }
      }
    ]);

    expect(derived.map((event) => event.family)).toEqual([null, null]);
    expect(derived.map((event) => event.procedure)).toEqual(["request", "read"]);
  });
});
