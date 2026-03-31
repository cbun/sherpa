import type { ResolvedSherpaPluginConfig } from "./config.js";
import { buildStatelessCaseId, type SherpaPolicyDecision } from "./policy.js";

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "task";
}

export type TaskBoundary = {
  caseId: string;
  title: string;
  slug: string;
  reason: "explicit" | "auto-first-message" | "auto-idle-timeout";
};

type ActiveCaseState = {
  caseId: string;
  lastMessageAt: number;
};

export class SherpaCaseRouter {
  private readonly activeCases = new Map<string, ActiveCaseState>();

  constructor(private readonly config: ResolvedSherpaPluginConfig) {}

  private normalizedSessionKey(sessionKey: string | undefined) {
    const normalized = sessionKey?.trim().toLowerCase();
    return normalized || null;
  }

  resolveActiveCaseId(params: {
    policy: SherpaPolicyDecision;
    sessionKey?: string | undefined;
    sessionId?: string | undefined;
    runId?: string | undefined;
    toolCallId?: string | undefined;
    timestamp?: number | undefined;
  }) {
    if (params.policy.stateless) {
      return buildStatelessCaseId(params);
    }

    const sessionKey = this.normalizedSessionKey(params.sessionKey);
    if (!sessionKey) {
      return undefined;
    }

    return this.activeCases.get(sessionKey)?.caseId;
  }

  detectTaskBoundary(content: string) {
    if (!this.config.caseSplitting.enabled) {
      return null;
    }

    const trimmed = content.trim();
    const lowered = trimmed.toLowerCase();

    for (const marker of this.config.caseSplitting.markers) {
      const normalizedMarker = marker.trim().toLowerCase();
      if (!normalizedMarker) {
        continue;
      }

      if (!lowered.startsWith(normalizedMarker)) {
        continue;
      }

      const remainder = trimmed.slice(marker.length).trim();
      return remainder.length > 0 ? remainder : "new task";
    }

    return null;
  }

  private normalizeAutomaticTitle(content: string) {
    const normalized = content.replaceAll(/\s+/g, " ").trim();
    if (!normalized) {
      return null;
    }

    const firstSentence = normalized.split(/(?<=[.!?])\s+/u, 1)[0] ?? normalized;
    const trimmed = firstSentence.replaceAll(/^[\s\-*:>#]+|[\s\-:;,.!?]+$/g, "").trim();

    if (!trimmed) {
      return null;
    }

    return trimmed.slice(0, 72);
  }

  private detectAutomaticBoundary(params: {
    sessionKey: string;
    content: string;
    timestamp?: number | undefined;
  }) {
    if (!this.config.caseSplitting.enabled || !this.config.caseSplitting.auto.enabled) {
      return null;
    }

    const normalizedTitle = this.normalizeAutomaticTitle(params.content);
    if (!normalizedTitle || normalizedTitle.length < this.config.caseSplitting.auto.minContentChars) {
      return null;
    }

    const timestamp = typeof params.timestamp === "number" ? params.timestamp : Date.now();
    const current = this.activeCases.get(params.sessionKey);

    if (!current) {
      return {
        title: normalizedTitle,
        reason: "auto-first-message" as const,
        timestamp
      };
    }

    if (timestamp - current.lastMessageAt >= this.config.caseSplitting.auto.idleTimeoutMs) {
      return {
        title: normalizedTitle,
        reason: "auto-idle-timeout" as const,
        timestamp
      };
    }

    this.activeCases.set(params.sessionKey, {
      ...current,
      lastMessageAt: timestamp
    });

    return null;
  }

  routeDispatch(params: {
    policy: SherpaPolicyDecision;
    sessionKey?: string | undefined;
    content: string;
    timestamp?: number | undefined;
  }) {
    if (params.policy.stateless) {
      return {
        boundary: null,
        caseId: null
      };
    }

    const sessionKey = this.normalizedSessionKey(params.sessionKey);
    if (!sessionKey) {
      return {
        boundary: null,
        caseId: null
      };
    }

    const explicitTitle = this.detectTaskBoundary(params.content);
    const automaticBoundary =
      explicitTitle === null
        ? this.detectAutomaticBoundary({
            sessionKey,
            content: params.content,
            timestamp: params.timestamp
          })
        : null;

    const title = explicitTitle ?? automaticBoundary?.title ?? null;
    const reason = explicitTitle
      ? ("explicit" as const)
      : automaticBoundary?.reason ?? null;

    if (!title || !reason) {
      return {
        boundary: null,
        caseId: this.activeCases.get(sessionKey)?.caseId ?? null
      };
    }

    const slug = slugify(title);
    const timestamp = automaticBoundary?.timestamp ?? (typeof params.timestamp === "number" ? params.timestamp : Date.now());
    const caseId = `session:${sessionKey}:task:${slug}:${timestamp}`;

    this.activeCases.set(sessionKey, {
      caseId,
      lastMessageAt: timestamp
    });

    return {
      boundary: {
        caseId,
        title,
        slug,
        reason
      },
      caseId
    };
  }

  startTaskBoundary(params: {
    policy: SherpaPolicyDecision;
    sessionKey?: string | undefined;
    content: string;
    timestamp?: number | undefined;
  }): TaskBoundary | null {
    if (params.policy.stateless) {
      return null;
    }

    const sessionKey = this.normalizedSessionKey(params.sessionKey);
    if (!sessionKey) {
      return null;
    }

    const title = this.detectTaskBoundary(params.content);
    if (!title) {
      return null;
    }

    const slug = slugify(title);
    const suffix = typeof params.timestamp === "number" ? params.timestamp : Date.now();
    const caseId = `session:${sessionKey}:task:${slug}:${suffix}`;

    this.activeCases.set(sessionKey, {
      caseId,
      lastMessageAt: suffix
    });

    return {
      caseId,
      title,
      slug,
      reason: "explicit"
    };
  }

  clearSession(sessionKey: string | undefined) {
    const normalized = this.normalizedSessionKey(sessionKey);
    if (!normalized) {
      return;
    }

    this.activeCases.delete(normalized);
  }
}
