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
  preceding?: string | undefined;
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
  toolArgsSummary?: string | undefined;
};

type ToolFinishCaptureInput = ToolStartCaptureInput & {
  result?: unknown;
  error?: string;
  durationMs?: number;
  outputSnippet?: string | undefined;
};

type ToolFamily = "tool" | "browser" | "web" | "automation";

type TaxonomyContext = {
  kind: "message" | "session" | "task" | "tool";
  toolName?: string;
  toolFamily?: ToolFamily;
  phase?: "started" | "succeeded" | "failed";
  channel?: string;
  content?: string;
};

type TaskStartCaptureInput = {
  agentId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
  title: string;
  slug: string;
  reason?: "explicit" | "auto-first-message" | "auto-idle-timeout" | "auto-intent-shift";
  timestamp?: number | undefined;
};

type TaskEndCaptureInput = {
  agentId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
  title: string;
  slug: string;
  terminalType: "task.completed" | "task.failed" | "task.ended";
  reason?:
    | "explicit-complete"
    | "explicit-fail"
    | "auto-complete-phrase"
    | "auto-fail-phrase"
    | "session-end"
    | "superseded"
    | "stale-timeout";
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

function truncateText(value: string | undefined, maxChars: number) {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxChars);
}

function buildDispatchContext(config: ResolvedSherpaPluginConfig, input: DispatchCaptureInput) {
  if (config.ledger.redactRawText) {
    return undefined;
  }

  const text = truncateText(input.content, 500);
  const preceding = truncateText(input.preceding, 200);

  if (!text && !preceding) {
    return undefined;
  }

  return {
    ...(text ? { text } : {}),
    ...(preceding ? { preceding } : {})
  };
}

function buildToolContext(
  config: ResolvedSherpaPluginConfig,
  input: Pick<ToolStartCaptureInput, "toolArgsSummary"> & Pick<ToolFinishCaptureInput, "outputSnippet">
) {
  if (config.ledger.redactRawText) {
    return undefined;
  }

  const toolArgs = truncateText(input.toolArgsSummary, 300);
  const text = truncateText(input.outputSnippet, 500);

  if (!toolArgs && !text) {
    return undefined;
  }

  return {
    ...(text ? { text } : {}),
    ...(toolArgs ? { toolArgs } : {})
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

function applyTaxonomyRules(
  config: ResolvedSherpaPluginConfig,
  event: SherpaEventInput,
  context: TaxonomyContext
) {
  if (config.taxonomy.rules.length === 0) {
    return event;
  }

  const labels = new Set(event.labels ?? []);

  for (const rule of config.taxonomy.rules) {
    const match = rule.match;

    if (match.kind && match.kind !== context.kind) {
      continue;
    }

    if (match.source && event.source !== match.source) {
      continue;
    }

    if (match.type && event.type !== match.type) {
      continue;
    }

    if (match.actor && event.actor !== match.actor) {
      continue;
    }

    if (match.toolName && context.toolName !== match.toolName) {
      continue;
    }

    if (match.toolFamily && context.toolFamily !== match.toolFamily) {
      continue;
    }

    if (match.phase && context.phase !== match.phase) {
      continue;
    }

    if (match.channel && context.channel !== match.channel) {
      continue;
    }

    if (match.contentPattern) {
      let matches = false;

      try {
        matches = new RegExp(match.contentPattern, "i").test(context.content ?? "");
      } catch {
        matches = false;
      }

      if (!matches) {
        continue;
      }
    }

    if (rule.set.type) {
      event.type = rule.set.type;
    }

    if (rule.set.outcome) {
      event.outcome = rule.set.outcome;
    }

    for (const label of rule.set.labels) {
      if (label.trim()) {
        labels.add(label);
      }
    }
  }

  event.labels = [...labels];
  return event;
}

export function buildSessionStartEvent(
  config: ResolvedSherpaPluginConfig,
  input: SessionCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput {
  const agentId = resolveAgentId(input);
  const type = input.resumedFrom ? "session.resumed" : "session.started";

  return applyTaxonomyRules(config, {
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
  }, {
    kind: "session"
  });
}

export function buildSessionEndEvent(
  config: ResolvedSherpaPluginConfig,
  input: SessionEndCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput {
  const agentId = resolveAgentId(input);

  return applyTaxonomyRules(config, {
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
  }, {
    kind: "session"
  });
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
  const normalizedChannel = safeString(input.channel);

  return applyTaxonomyRules(config, {
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
    meta: buildMessageMeta(config, input, agentId),
    context: buildDispatchContext(config, input)
  }, {
    kind: "message",
    ...(normalizedChannel ? { channel: normalizedChannel } : {}),
    content: input.content
  });
}

export function buildTaskStartEvent(
  config: ResolvedSherpaPluginConfig,
  input: TaskStartCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput {
  const agentId = resolveAgentId(input);

  return applyTaxonomyRules(config, {
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
  }, {
    kind: "task"
  });
}

export function buildTaskEndEvent(
  config: ResolvedSherpaPluginConfig,
  input: TaskEndCaptureInput,
  options?: CaptureEventOptions
): SherpaEventInput {
  const agentId = resolveAgentId(input);
  const outcome =
    input.terminalType === "task.completed"
      ? "success"
      : input.terminalType === "task.failed"
        ? "failure"
        : "unknown";

  return applyTaxonomyRules(config, {
    agentId,
    caseId: options?.caseId ?? buildSessionCaseId(input),
    ts: typeof input.timestamp === "number" ? new Date(input.timestamp).toISOString() : undefined,
    source: "openclaw.task",
    type: input.terminalType,
    actor: "user",
    outcome,
    labels: [
      `task:${input.slug}`,
      ...(input.reason ? [`task-terminal:${input.reason}`] : [])
    ],
    metrics: {
      titleChars: input.title.length
    },
    meta: clampMeta(
      {
        sessionId: safeString(input.sessionId),
        sessionKey: safeString(input.sessionKey),
        terminalReason: safeString(input.reason),
        ...(config.ledger.redactRawText ? {} : { title: input.title })
      },
      config.ledger.maxMetaBytes
    )
  }, {
    kind: "task"
  });
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

  return applyTaxonomyRules(config, {
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
    meta: buildToolMeta(config, input),
    context: buildToolContext(config, input)
  }, {
    kind: "tool",
    toolName: input.toolName,
    toolFamily: family,
    phase: "started"
  });
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
  const phase = succeeded ? "succeeded" : "failed";

  return applyTaxonomyRules(config, {
    agentId,
    caseId: options?.caseId ?? buildSessionCaseId(input),
    source: `openclaw.${family}`,
    type: buildToolType(family, phase),
    actor: "agent",
    outcome: succeeded ? "success" : "failure",
    labels: buildToolLabels(input.toolName, family),
    metrics: {
      paramCount: Object.keys(input.params).length,
      ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
      ...(input.result !== undefined ? { hasResult: 1 } : {})
    },
    meta: buildToolMeta(config, input),
    context: buildToolContext(config, input)
  }, {
    kind: "tool",
    toolName: input.toolName,
    toolFamily: family,
    phase
  });
}
