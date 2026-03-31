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
};

export class SherpaCaseRouter {
  private readonly activeCases = new Map<string, string>();

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

    return this.activeCases.get(sessionKey);
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

    this.activeCases.set(sessionKey, caseId);

    return {
      caseId,
      title,
      slug
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
