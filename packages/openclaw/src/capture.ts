import type { SherpaEventInput } from "@sherpa/core";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";

import type { ResolvedSherpaPluginConfig } from "./config.js";

type CaptureEventOptions = {
  caseId?: string | undefined;
};

type SessionCaptureInput = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  resumedFrom?: string;
};

type SessionEndCaptureInput = SessionCaptureInput & {
  messageCount: number;
  durationMs?: number;
};

type DispatchCaptureInput = {
  sessionKey?: string | undefined;
  channel?: string;
  senderId?: string;
  content: string;
  timestamp?: number;
  isGroup?: boolean;
};

type ToolStartCaptureInput = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
  toolName: string;
  params: Record<string, unknown>;
};

type ToolFinishCaptureInput = ToolStartCaptureInput & {
  result?: unknown;
  error?: string;
  durationMs?: number;
};

type ToolFamily = "tool" | "browser" | "web" | "automation";

type TaskStartCaptureInput = {
  agentId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
  title: string;
  slug: string;
  reason?: "explicit" | "auto-first-message" | "auto-idle-timeout" | "auto-intent-shift";
  timestamp?: number | undefined;
};

function normalizeOpaqueId(value: string | undefined | null) {
  return (value ?? "")
    .trim()
    .replaceAll(/\s+/g, "-")
    .slice(0, 160);
}

function safeString(value: string | undefined | null) {
  const normalized = normalizeOpaqueId(value);
  return normalized.length > 0 ? normalized : null;
}

function resolveAgentId(params: { agentId?: string | undefined; sessionKey?: string | undefined }) {
  const agentId = safeString(params.agentId);
  if (agentId) {
    return agentId;
  }

  const sessionKey = safeString(params.sessionKey);
  if (sessionKey) {
    return resolveAgentIdFromSessionKey(sessionKey);
  }

  return "main";
}

function buildSessionCaseId(params: {
  agentId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
}) {
  const sessionKey = safeString(params.sessionKey);
  if (sessionKey) {
    return `session:${sessionKey}`;
  }

  const agentId = resolveAgentId(params);
  const sessionId = safeString(params.sessionId) ?? "default";
  return `agent:${agentId}:session:${sessionId}`;
}

function clampMeta(meta: Record<string, unknown>, maxMetaBytes: number) {
  const encoder = new TextEncoder();
  const next = { ...meta };

  if (encoder.encode(JSON.stringify(next)).length <= maxMetaBytes) {
    return next;
  }

  const sortedKeys = Object.entries(next)
    .sort((left, right) => JSON.stringify(right[1]).length - JSON.stringify(left[1]).length)
    .map(([key]) => key);

  for (const key of sortedKeys) {
    delete next[key];

    if (encoder.encode(JSON.stringify({ ...next, metaTruncated: true })).length <= maxMetaBytes) {
      return {
        ...next,
        metaTruncated: true
      };
    }
  }

  return {
    metaTruncated: true
  };
}

function buildMessageMeta(
  config: ResolvedSherpaPluginConfig,
  input: DispatchCaptureInput,
  agentId: string
) {
  const meta: Record<string, unknown> = {
    agentId,
    channel: safeString(input.channel),
    senderId: safeString(input.senderId),
    isGroup: Boolean(input.isGroup)
  };

  if (!config.ledger.redactRawText) {
    meta.preview = input.content.slice(0, 160);
  }

  return clampMeta(meta, config.ledger.maxMetaBytes);
}

function buildToolMeta(config: ResolvedSherpaPluginConfig, input: ToolStartCaptureInput | ToolFinishCaptureInput) {
  return clampMeta(
    {
      sessionKey: safeString(input.sessionKey),
      sessionId: safeString(input.sessionId),
      runId: safeString(input.runId),
      toolCallId: safeString(input.toolCallId),
      paramKeys: Object.keys(input.params).sort().slice(0, 16)
    },
    config.ledger.maxMetaBytes
  );
}

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

  if (normalized.includes("web") || normalized.includes("search") || normalized.includes("fetch") || normalized.includes("scrape")) {
    return "web";
  }

  if (normalized.includes("automation") || normalized.includes("cron") || normalized.includes("schedule")) {
    return "automation";
  }

  return "tool";
}

function captureEnabledForTool(config: ResolvedSherpaPluginConfig, family: ToolFamily) {
  if (!config.capture.tools) {
    return false;
  }

  if (family === "browser") {
    return config.capture.browser;
  }

  if (family === "web") {
    return config.capture.web;
  }

  if (family === "automation") {
    return config.capture.automation;
  }

  return true;
}

function buildToolType(family: ToolFamily, phase: "started" | "succeeded" | "failed") {
  return family === "tool" ? `tool.${phase}` : `${family}.${phase}`;
}

function buildToolLabels(toolName: string, family: ToolFamily) {
  return [`tool:${toolName}`, `tool-family:${family}`];
}

export function buildSessionStartEvent(
  config: ResolvedSherpaPluginConfig,
  input: SessionCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput {
  const agentId = resolveAgentId(input);
  const type = input.resumedFrom ? "session.resumed" : "session.started";

  return {
    agentId,
    caseId: options?.caseId ?? buildSessionCaseId(input),
    source: "openclaw.session",
    type,
    actor: "system",
    outcome: "unknown",
    labels: input.resumedFrom ? ["session:resumed"] : [],
    meta: clampMeta(
      {
        sessionId: safeString(input.sessionId),
        sessionKey: safeString(input.sessionKey),
        resumedFrom: safeString(input.resumedFrom)
      },
      config.ledger.maxMetaBytes
    )
  };
}

export function buildSessionEndEvent(
  config: ResolvedSherpaPluginConfig,
  input: SessionEndCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput {
  const agentId = resolveAgentId(input);

  return {
    agentId,
    caseId: options?.caseId ?? buildSessionCaseId(input),
    source: "openclaw.session",
    type: "session.ended",
    actor: "system",
    outcome: "success",
    metrics: {
      messageCount: input.messageCount,
      ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {})
    },
    meta: clampMeta(
      {
        sessionId: safeString(input.sessionId),
        sessionKey: safeString(input.sessionKey)
      },
      config.ledger.maxMetaBytes
    )
  };
}

export function buildDispatchEvent(
  config: ResolvedSherpaPluginConfig,
  input: DispatchCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput | null {
  if (!config.capture.messages) {
    return null;
  }

  const agentId = resolveAgentId(
    input.sessionKey
      ? {
          sessionKey: input.sessionKey
        }
      : {}
  );
  const caseId = buildSessionCaseId({
    agentId,
    ...(input.sessionKey
      ? {
          sessionKey: input.sessionKey
        }
      : {})
  });

  return {
    agentId,
    caseId: options?.caseId ?? caseId,
    ts: typeof input.timestamp === "number" ? new Date(input.timestamp).toISOString() : undefined,
    source: "openclaw.dispatch",
    type: "message.received",
    actor: "user",
    outcome: "unknown",
    labels: [safeString(input.channel) ? `channel:${safeString(input.channel)}` : null].filter(Boolean) as string[],
    metrics: {
      contentChars: input.content.length
    },
    meta: buildMessageMeta(config, input, agentId)
  };
}

export function buildTaskStartEvent(
  config: ResolvedSherpaPluginConfig,
  input: TaskStartCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput {
  const agentId = resolveAgentId(input);

  return {
    agentId,
    caseId: options?.caseId ?? buildSessionCaseId(input),
    ts: typeof input.timestamp === "number" ? new Date(input.timestamp).toISOString() : undefined,
    source: "openclaw.task",
    type: "task.started",
    actor: "user",
    outcome: "unknown",
    labels: [
      `task:${input.slug}`,
      ...(input.reason ? [`task-boundary:${input.reason}`] : [])
    ],
    metrics: {
      titleChars: input.title.length
    },
    meta: clampMeta(
      {
        sessionId: safeString(input.sessionId),
        sessionKey: safeString(input.sessionKey),
        boundaryReason: safeString(input.reason),
        ...(config.ledger.redactRawText ? {} : { title: input.title })
      },
      config.ledger.maxMetaBytes
    )
  };
}

export function buildToolStartEvent(
  config: ResolvedSherpaPluginConfig,
  input: ToolStartCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput | null {
  const family = classifyToolFamily(input.toolName);
  if (!captureEnabledForTool(config, family)) {
    return null;
  }

  const agentId = resolveAgentId(input);

  return {
    agentId,
    caseId: options?.caseId ?? buildSessionCaseId(input),
    source: `openclaw.${family}`,
    type: buildToolType(family, "started"),
    actor: "agent",
    outcome: "unknown",
    labels: buildToolLabels(input.toolName, family),
    metrics: {
      paramCount: Object.keys(input.params).length
    },
    meta: buildToolMeta(config, input)
  };
}

export function buildToolFinishEvent(
  config: ResolvedSherpaPluginConfig,
  input: ToolFinishCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput | null {
  const family = classifyToolFamily(input.toolName);
  if (!captureEnabledForTool(config, family)) {
    return null;
  }

  const agentId = resolveAgentId(input);
  const succeeded = !input.error;

  return {
    agentId,
    caseId: options?.caseId ?? buildSessionCaseId(input),
    source: `openclaw.${family}`,
    type: buildToolType(family, succeeded ? "succeeded" : "failed"),
    actor: "agent",
    outcome: succeeded ? "success" : "failure",
    labels: buildToolLabels(input.toolName, family),
    metrics: {
      paramCount: Object.keys(input.params).length,
      ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
      ...(input.result !== undefined ? { hasResult: 1 } : {})
    },
    meta: buildToolMeta(config, input)
  };
}
