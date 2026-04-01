import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedSessionStart {
  kind: "session.start";
  id: string;
  timestamp: string;
  cwd: string;
}

export interface ParsedUserMessage {
  kind: "user.message";
  id: string;
  parentId: string | null;
  timestamp: string;
  text: string;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedAssistantMessage {
  kind: "assistant.message";
  id: string;
  parentId: string | null;
  timestamp: string;
  text: string;
  toolCalls: ParsedToolCall[];
  model: string | null;
}

export interface ParsedToolResult {
  kind: "tool.result";
  id: string;
  parentId: string | null;
  timestamp: string;
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export interface ParsedSessionEnd {
  kind: "session.end";
  timestamp: string;
}

export type ParsedSessionEvent =
  | ParsedSessionStart
  | ParsedUserMessage
  | ParsedAssistantMessage
  | ParsedToolResult
  | ParsedSessionEnd;

export interface ParsedSession {
  id: string;
  timestamp: string;
  events: ParsedSessionEvent[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return (content as Array<Record<string, unknown>>)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => (block.text as string).slice(0, 500))
    .join("\n")
    .slice(0, 2000);
}

function extractToolCalls(content: unknown): ParsedToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return (content as Array<Record<string, unknown>>)
    .filter((block) => block.type === "toolCall" || block.type === "tool_use")
    .map((block) => ({
      id: String(block.id ?? ""),
      name: String(block.name ?? ""),
      arguments:
        typeof block.arguments === "object" && block.arguments !== null
          ? (block.arguments as Record<string, unknown>)
          : typeof block.input === "object" && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {}
    }));
}

function parseLine(raw: string): ParsedSessionEvent | null {
  let obj: Record<string, unknown>;

  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = obj.type as string | undefined;

  if (type === "session") {
    return {
      kind: "session.start",
      id: String(obj.id ?? ""),
      timestamp: String(obj.timestamp ?? new Date().toISOString()),
      cwd: String(obj.cwd ?? "")
    };
  }

  if (type === "message") {
    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) {
      return null;
    }

    const role = msg.role as string | undefined;
    const timestamp = String(obj.timestamp ?? new Date().toISOString());
    const id = String(obj.id ?? "");
    const parentId = obj.parentId ? String(obj.parentId) : null;

    if (role === "user") {
      return {
        kind: "user.message",
        id,
        parentId,
        timestamp,
        text: extractText(msg.content).slice(0, 500)
      };
    }

    if (role === "assistant") {
      const toolCalls = extractToolCalls(msg.content);
      const text = extractText(msg.content);
      return {
        kind: "assistant.message",
        id,
        parentId,
        timestamp,
        text: text.slice(0, 500),
        toolCalls,
        model: typeof msg.model === "string" ? msg.model : null
      };
    }

    if (role === "toolResult" || role === "tool") {
      const content = extractText(msg.content);
      return {
        kind: "tool.result",
        id,
        parentId,
        timestamp,
        toolCallId: String(msg.toolCallId ?? ""),
        toolName: String(msg.toolName ?? ""),
        content: content.slice(0, 500),
        isError: Boolean(msg.is_error ?? msg.isError ?? false)
      };
    }
  }

  // Skip model_change, thinking_level_change, custom, etc.
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function parseSessionLog(filePath: string): Promise<ParsedSession> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

  const events: ParsedSessionEvent[] = [];
  let sessionId = path.basename(filePath, path.extname(filePath)).replace(/\.jsonl.*/, "");
  let sessionTimestamp = "";

  for (const line of lines) {
    const event = parseLine(line);
    if (!event) {
      continue;
    }

    if (event.kind === "session.start") {
      sessionId = event.id || sessionId;
      sessionTimestamp = event.timestamp;
    }

    events.push(event);
  }

  // Sort by timestamp
  events.sort((a, b) => {
    const tsA = "timestamp" in a ? a.timestamp : "";
    const tsB = "timestamp" in b ? b.timestamp : "";
    return tsA.localeCompare(tsB);
  });

  // Synthesize session end
  if (events.length > 0) {
    const lastEvent = events[events.length - 1]!;
    const lastTs = "timestamp" in lastEvent ? lastEvent.timestamp : sessionTimestamp;
    events.push({
      kind: "session.end",
      timestamp: lastTs
    });
  }

  return {
    id: sessionId,
    timestamp: sessionTimestamp || new Date().toISOString(),
    events
  };
}

export async function findSessionFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name.endsWith(".jsonl") || entry.name.includes(".jsonl.reset.")) {
      files.push(path.join(dirPath, entry.name));
    }
  }

  // Sort by modification time (oldest first for cumulative learning)
  const withStats = await Promise.all(
    files.map(async (filePath) => {
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    })
  );

  return withStats
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((entry) => entry.filePath);
}
