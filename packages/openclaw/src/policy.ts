import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";

import type { ResolvedSherpaPluginConfig } from "./config.js";

type CaptureChatType = "direct" | "group" | "channel" | "dm" | "unknown";

export interface SherpaPolicyContext {
  agentId?: string | undefined;
  sessionKey?: string | undefined;
  channel?: string | undefined;
  isGroup?: boolean | undefined;
}

export interface SherpaPolicyDecision {
  allowed: boolean;
  stateless: boolean;
  reason: string;
  agentId: string;
  normalizedSessionKey: string | null;
  chatType: CaptureChatType;
}

function escapeRegex(value: string) {
  return value.replaceAll(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string) {
  let escaped = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    const next = pattern.charAt(index + 1);

    if (char === "*" && next === "*") {
      escaped += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      escaped += "[^:]*";
      continue;
    }

    escaped += escapeRegex(char);
  }

  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(patterns: string[], value: string | null) {
  if (!value) {
    return false;
  }

  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function normalizeSessionKey(sessionKey: string | undefined) {
  const normalized = sessionKey?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function deriveChatType(context: SherpaPolicyContext): CaptureChatType {
  const normalized = normalizeSessionKey(context.sessionKey);
  if (normalized) {
    if (normalized.includes(":direct:")) {
      return "direct";
    }

    if (normalized.includes(":group:")) {
      return "group";
    }

    if (normalized.includes(":channel:")) {
      return "channel";
    }

    if (normalized.includes(":dm:")) {
      return "dm";
    }
  }

  if (context.isGroup === true) {
    return "group";
  }

  if (context.isGroup === false) {
    return "direct";
  }

  return "unknown";
}

function resolveAgentId(context: SherpaPolicyContext, normalizedSessionKey: string | null) {
  if (context.agentId?.trim()) {
    return context.agentId.trim();
  }

  if (normalizedSessionKey) {
    return resolveAgentIdFromSessionKey(normalizedSessionKey);
  }

  return "main";
}

function ruleMatches(
  rule: ResolvedSherpaPluginConfig["scope"]["rules"][number],
  params: {
    normalizedSessionKey: string | null;
    rawSessionKey: string | null;
    channel: string | null;
    chatType: CaptureChatType;
    agentId: string;
  }
) {
  if (rule.match.chatType && rule.match.chatType !== params.chatType) {
    return false;
  }

  if (rule.match.channel && rule.match.channel !== params.channel) {
    return false;
  }

  if (rule.match.agentId && rule.match.agentId !== params.agentId) {
    return false;
  }

  if (rule.match.sessionPrefix && !params.normalizedSessionKey?.startsWith(rule.match.sessionPrefix.toLowerCase())) {
    return false;
  }

  if (rule.match.rawSessionPrefix && !params.rawSessionKey?.startsWith(rule.match.rawSessionPrefix)) {
    return false;
  }

  return true;
}

export function resolveSherpaPolicyDecision(
  config: ResolvedSherpaPluginConfig,
  context: SherpaPolicyContext
): SherpaPolicyDecision {
  const rawSessionKey = context.sessionKey?.trim() || null;
  const normalizedSessionKey = normalizeSessionKey(context.sessionKey);
  const chatType = deriveChatType(context);
  const agentId = resolveAgentId(context, normalizedSessionKey);
  const channel = context.channel?.trim().toLowerCase() || null;

  if (matchesPattern(config.ignoreSessionPatterns, rawSessionKey) || matchesPattern(config.ignoreSessionPatterns, normalizedSessionKey)) {
    return {
      allowed: false,
      stateless: false,
      reason: "ignored_session_pattern",
      agentId,
      normalizedSessionKey,
      chatType
    };
  }

  const stateless =
    matchesPattern(config.statelessSessionPatterns, rawSessionKey) ||
    matchesPattern(config.statelessSessionPatterns, normalizedSessionKey);

  for (const rule of config.scope.rules) {
    if (
      ruleMatches(rule, {
        normalizedSessionKey,
        rawSessionKey,
        channel,
        chatType,
        agentId
      })
    ) {
      return {
        allowed: rule.action === "allow",
        stateless,
        reason: `scope_rule:${rule.action}`,
        agentId,
        normalizedSessionKey,
        chatType
      };
    }
  }

  return {
    allowed: config.scope.defaultAction === "allow",
    stateless,
    reason: `scope_default:${config.scope.defaultAction}`,
    agentId,
    normalizedSessionKey,
    chatType
  };
}

export function buildStatelessCaseId(params: {
  policy: SherpaPolicyDecision;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
  runId?: string | undefined;
  toolCallId?: string | undefined;
  timestamp?: number | undefined;
}) {
  const base = params.policy.normalizedSessionKey
    ? `session:${params.policy.normalizedSessionKey}`
    : `agent:${params.policy.agentId}`;
  const discriminator =
    params.sessionId?.trim() ||
    params.runId?.trim() ||
    params.toolCallId?.trim() ||
    (typeof params.timestamp === "number" ? `ts:${params.timestamp}` : "event");

  return `${base}:stateless:${discriminator}`;
}
