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
  reason: "explicit" | "auto-first-message" | "auto-idle-timeout" | "auto-intent-shift";
};

type DispatchTerminalDetection = {
  terminalType: "task.completed" | "task.failed";
  reason: "explicit-complete" | "explicit-fail" | "auto-complete-phrase" | "auto-fail-phrase";
};

export type TaskTerminal = {
  caseId: string;
  title: string;
  slug: string;
  terminalType: "task.completed" | "task.failed" | "task.ended";
  reason:
    | "explicit-complete"
    | "explicit-fail"
    | "auto-complete-phrase"
    | "auto-fail-phrase"
    | "session-end"
    | "superseded"
    | "stale-timeout";
};

type ActiveCaseState = {
  caseId: string;
  lastMessageAt: number;
  title: string;
  titleTokens: string[];
  slug: string;
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "by",
  "can",
  "for",
  "from",
  "help",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "the",
  "this",
  "to",
  "us",
  "we",
  "with",
  "you"
]);

function tokenize(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
    .slice(0, 16);
}

export class SherpaCaseRouter {
  private readonly activeCases = new Map<string, ActiveCaseState>();

  constructor(private readonly config: ResolvedSherpaPluginConfig) {}

  private normalizedSessionKey(sessionKey: string | undefined) {
    const normalized = sessionKey?.trim().toLowerCase();
    return normalized || null;
  }

  private expireStaleCase(sessionKey: string, timestamp?: number | undefined) {
    const current = this.activeCases.get(sessionKey);
    if (!current) {
      return null;
    }

    const now = typeof timestamp === "number" ? timestamp : Date.now();
    if (now - current.lastMessageAt < this.config.caseSplitting.auto.staleTimeoutMs) {
      return null;
    }

    this.activeCases.delete(sessionKey);
    return {
      caseId: current.caseId,
      title: current.title,
      slug: current.slug,
      terminalType: "task.ended" as const,
      reason: "stale-timeout" as const
    };
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

    this.expireStaleCase(sessionKey, params.timestamp);
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

  private computeTokenOverlap(left: string[], right: string[]) {
    if (left.length === 0 || right.length === 0) {
      return 0;
    }

    const rightSet = new Set(right);
    const shared = left.filter((token) => rightSet.has(token)).length;
    return shared / Math.max(left.length, right.length);
  }

  private detectShiftPhrase(content: string) {
    const lowered = content.trim().toLowerCase();

    for (const phrase of this.config.caseSplitting.auto.shiftPhrases) {
      const normalized = phrase.trim().toLowerCase();
      if (!normalized) {
        continue;
      }

      if (
        lowered.startsWith(normalized) ||
        lowered.startsWith(`${normalized}:`) ||
        lowered.startsWith(`${normalized},`)
      ) {
        return normalized;
      }
    }

    return null;
  }

  private startsWithAnyPhrase(content: string, phrases: string[]) {
    const lowered = content.trim().toLowerCase();

    for (const phrase of phrases) {
      const normalized = phrase.trim().toLowerCase();
      if (!normalized) {
        continue;
      }

      if (
        lowered === normalized ||
        lowered.startsWith(`${normalized} `) ||
        lowered.startsWith(`${normalized}.`) ||
        lowered.startsWith(`${normalized},`) ||
        lowered.startsWith(`${normalized}:`) ||
        lowered.startsWith(`${normalized}!`) ||
        lowered.startsWith(`${normalized}?`)
      ) {
        return normalized;
      }
    }

    return null;
  }

  private isAcknowledgmentMessage(content: string) {
    if (this.startsWithAnyPhrase(content, this.config.caseSplitting.auto.acknowledgmentPhrases) === null) {
      return false;
    }

    return tokenize(content).length <= 4;
  }

  private detectTerminalMarker(content: string) {
    const trimmed = content.trim().toLowerCase();

    for (const marker of this.config.caseSplitting.completeMarkers) {
      const normalizedMarker = marker.trim().toLowerCase();
      if (normalizedMarker && trimmed.startsWith(normalizedMarker)) {
        return {
          terminalType: "task.completed" as const,
          reason: "explicit-complete" as const
        };
      }
    }

    for (const marker of this.config.caseSplitting.failMarkers) {
      const normalizedMarker = marker.trim().toLowerCase();
      if (normalizedMarker && trimmed.startsWith(normalizedMarker)) {
        return {
          terminalType: "task.failed" as const,
          reason: "explicit-fail" as const
        };
      }
    }

    return null;
  }

  private detectTerminalSignal(content: string): DispatchTerminalDetection | null {
    const marker = this.detectTerminalMarker(content);
    if (marker) {
      return marker;
    }

    if (this.startsWithAnyPhrase(content, this.config.caseSplitting.auto.completePhrases)) {
      return {
        terminalType: "task.completed",
        reason: "auto-complete-phrase"
      };
    }

    if (this.startsWithAnyPhrase(content, this.config.caseSplitting.auto.failPhrases)) {
      return {
        terminalType: "task.failed",
        reason: "auto-fail-phrase"
      };
    }

    return null;
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

    if (this.isAcknowledgmentMessage(normalizedTitle)) {
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

    const shiftPhrase = this.detectShiftPhrase(params.content);
    if (shiftPhrase) {
      const contentTokens = tokenize(normalizedTitle);
      const overlap = this.computeTokenOverlap(current.titleTokens, contentTokens);

      if (overlap <= this.config.caseSplitting.auto.maxTitleTokenOverlap) {
        return {
          title: normalizedTitle,
          reason: "auto-intent-shift" as const,
          timestamp
        };
      }
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
        terminal: null,
        caseId: null
      };
    }

    const sessionKey = this.normalizedSessionKey(params.sessionKey);
    if (!sessionKey) {
      return {
        boundary: null,
        terminal: null,
        caseId: null
      };
    }

    const staleTerminal = this.expireStaleCase(sessionKey, params.timestamp);
    const current = this.activeCases.get(sessionKey) ?? null;
    const terminalMarker = this.detectTerminalSignal(params.content);
    if (terminalMarker && current) {
      this.activeCases.delete(sessionKey);

      return {
        boundary: null,
        terminal: {
          caseId: current.caseId,
          title: current.title,
          slug: current.slug,
          terminalType: terminalMarker.terminalType,
          reason: terminalMarker.reason
        },
        caseId: current.caseId
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
        terminal: staleTerminal,
        caseId: current?.caseId ?? null
      };
    }

    const slug = slugify(title);
    const timestamp = automaticBoundary?.timestamp ?? (typeof params.timestamp === "number" ? params.timestamp : Date.now());
    const caseId = `session:${sessionKey}:task:${slug}:${timestamp}`;
    const terminal =
      staleTerminal ??
      (current && current.caseId !== caseId
        ? {
            caseId: current.caseId,
            title: current.title,
            slug: current.slug,
            terminalType: "task.ended" as const,
            reason: "superseded" as const
          }
        : null);

    this.activeCases.set(sessionKey, {
      caseId,
      lastMessageAt: timestamp,
      title,
      titleTokens: tokenize(title),
      slug
    });

    return {
      boundary: {
        caseId,
        title,
        slug,
        reason
      },
      terminal,
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
      lastMessageAt: suffix,
      title,
      titleTokens: tokenize(title),
      slug
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

  closeActiveCase(params: {
    sessionKey?: string | undefined;
    reason: "session-end" | "superseded" | "stale-timeout";
  }): TaskTerminal | null {
    const sessionKey = this.normalizedSessionKey(params.sessionKey);
    if (!sessionKey) {
      return null;
    }

    const current = this.activeCases.get(sessionKey);
    if (!current) {
      return null;
    }

    this.activeCases.delete(sessionKey);

    return {
      caseId: current.caseId,
      title: current.title,
      slug: current.slug,
      terminalType: "task.ended",
      reason: params.reason
    };
  }
}
