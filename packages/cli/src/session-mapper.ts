import type { SherpaEventInput } from "@sherpa/core";

import type {
  ParsedAssistantMessage,
  ParsedSession,
  ParsedSessionEvent,
  ParsedToolResult,
  ParsedUserMessage
} from "./session-parser.js";

// ---------------------------------------------------------------------------
// Tool family classifier (standalone, mirrors openclaw capture.ts logic)
// ---------------------------------------------------------------------------

type ToolFamily = "tool" | "browser" | "web" | "automation";

export function classifyToolFamily(toolName: string): ToolFamily {
  const normalized = toolName.trim().toLowerCase();

  if (
    normalized.includes("browser") ||
    normalized.includes("playwright") ||
    normalized.includes("chrome") ||
    normalized.includes("screenshot")
  ) {
    return "browser";
  }

  if (
    normalized.includes("web") ||
    normalized.includes("search") ||
    normalized.includes("fetch") ||
    normalized.includes("scrape")
  ) {
    return "web";
  }

  if (
    normalized.includes("automation") ||
    normalized.includes("cron") ||
    normalized.includes("schedule")
  ) {
    return "automation";
  }

  return "tool";
}

function buildToolType(family: ToolFamily, phase: "started" | "succeeded" | "failed") {
  return family === "tool" ? `tool.${phase}` : `${family}.${phase}`;
}

function buildToolLabels(toolName: string, family: ToolFamily) {
  return [`tool:${toolName}`, `tool-family:${family}`];
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

export interface MapperOptions {
  sessionId: string;
  agentId?: string;
}

function buildCaseId(options: MapperOptions) {
  return `session:${options.sessionId}`;
}

function mapUserMessage(event: ParsedUserMessage, options: MapperOptions): SherpaEventInput {
  return {
    agentId: options.agentId ?? "main",
    caseId: buildCaseId(options),
    ts: event.timestamp,
    source: "openclaw.dispatch",
    type: "message.user.inbound",
    actor: "user",
    outcome: "unknown",
    labels: [],
    metrics: {
      contentChars: event.text.length
    },
    meta: {
      preview: event.text.slice(0, 160)
    }
  };
}

function mapAssistantReply(event: ParsedAssistantMessage, options: MapperOptions): SherpaEventInput {
  return {
    agentId: options.agentId ?? "main",
    caseId: buildCaseId(options),
    ts: event.timestamp,
    source: "openclaw.dispatch",
    type: "message.assistant.reply",
    actor: "agent",
    outcome: "unknown",
    labels: [],
    metrics: {
      contentChars: event.text.length,
      toolCallCount: event.toolCalls.length
    },
    meta: {
      preview: event.text.slice(0, 160),
      ...(event.model ? { model: event.model } : {})
    }
  };
}

function mapToolStarted(
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  timestamp: string,
  options: MapperOptions
): SherpaEventInput {
  const family = classifyToolFamily(toolCall.name);
  return {
    agentId: options.agentId ?? "main",
    caseId: buildCaseId(options),
    ts: timestamp,
    source: `openclaw.${family}`,
    type: buildToolType(family, "started"),
    actor: "agent",
    outcome: "unknown",
    labels: buildToolLabels(toolCall.name, family),
    metrics: {
      paramCount: Object.keys(toolCall.arguments).length
    },
    meta: {
      toolCallId: toolCall.id,
      paramKeys: Object.keys(toolCall.arguments).sort().slice(0, 16)
    }
  };
}

function mapToolResult(event: ParsedToolResult, options: MapperOptions): SherpaEventInput {
  const family = classifyToolFamily(event.toolName);
  const phase = event.isError ? "failed" : "succeeded";
  return {
    agentId: options.agentId ?? "main",
    caseId: buildCaseId(options),
    ts: event.timestamp,
    source: `openclaw.${family}`,
    type: buildToolType(family, phase),
    actor: "agent",
    outcome: event.isError ? "failure" : "success",
    labels: buildToolLabels(event.toolName, family),
    metrics: {
      resultChars: event.content.length
    },
    meta: {
      toolCallId: event.toolCallId
    }
  };
}

function mapSessionStarted(sessionId: string, timestamp: string, options: MapperOptions): SherpaEventInput {
  return {
    agentId: options.agentId ?? "main",
    caseId: buildCaseId(options),
    ts: timestamp,
    source: "openclaw.session",
    type: "session.started",
    actor: "system",
    outcome: "unknown",
    labels: [],
    meta: {
      sessionId
    }
  };
}

function mapSessionEnded(timestamp: string, options: MapperOptions): SherpaEventInput {
  return {
    agentId: options.agentId ?? "main",
    caseId: buildCaseId(options),
    ts: timestamp,
    source: "openclaw.session",
    type: "session.ended",
    actor: "system",
    outcome: "success",
    labels: [],
    meta: {}
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mapSessionToSherpaEvents(session: ParsedSession): SherpaEventInput[] {
  const options: MapperOptions = { sessionId: session.id };
  const events: SherpaEventInput[] = [];

  for (const event of session.events) {
    switch (event.kind) {
      case "session.start":
        events.push(mapSessionStarted(event.id, event.timestamp, options));
        break;

      case "user.message":
        events.push(mapUserMessage(event, options));
        break;

      case "assistant.message":
        // Emit the reply event
        if (event.text.length > 0 || event.toolCalls.length === 0) {
          events.push(mapAssistantReply(event, options));
        }
        // Emit tool.started for each tool call
        for (const toolCall of event.toolCalls) {
          events.push(mapToolStarted(toolCall, event.timestamp, options));
        }
        break;

      case "tool.result":
        events.push(mapToolResult(event, options));
        break;

      case "session.end":
        events.push(mapSessionEnded(event.timestamp, options));
        break;
    }
  }

  return events;
}

export function mapSessionsToSherpaEvents(sessions: ParsedSession[]): SherpaEventInput[] {
  return sessions.flatMap(mapSessionToSherpaEvents);
}
