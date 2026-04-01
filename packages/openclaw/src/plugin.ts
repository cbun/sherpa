import type { SherpaEventInput } from "@sherpa/core";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/core";

import {
  buildDispatchEvent,
  buildSessionEndEvent,
  buildSessionStartEvent,
  buildTaskEndEvent,
  buildTaskStartEvent,
  buildToolFinishEvent,
  buildToolStartEvent
} from "./capture.js";
import { interpretAdvisory, type ConversationTurn } from "./advisory-interpreter.js";
import { backendNeedsRefresh, createSherpaBackend, type SherpaPluginRuntime } from "./backend.js";
import { SherpaCaseRouter } from "./cases.js";
import { resolveSherpaPluginConfig, type SherpaPluginConfig } from "./config.js";
import { createManagedDaemonSupervisor } from "./daemon.js";
import { createSherpaMaintenanceRuntime } from "./maintenance.js";
import { buildStatelessCaseId, resolveSherpaPolicyDecision } from "./policy.js";

function detectAgentId(params: { agentId?: string | undefined; caseId?: string | undefined }) {
  if (params.agentId) {
    return params.agentId;
  }

  if (params.caseId?.startsWith("agent:")) {
    const [, maybeAgentId] = params.caseId.split(":");
    return maybeAgentId || "main";
  }

  if (params.caseId?.startsWith("session:agent:")) {
    const [, , maybeAgentId] = params.caseId.split(":");
    return maybeAgentId || "main";
  }

  return "main";
}

const runtimeCache = new Map<string, SherpaPluginRuntime>();
const resolvedConfigCache = new Map<string, ReturnType<typeof resolveSherpaPluginConfig>>();
const promptContextCache = new Map<string, { text?: string; preceding?: string }>();

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function summarizeUnknown(value: unknown, maxChars: number) {
  if (typeof value === "string") {
    return truncateText(value, maxChars);
  }

  if (value === undefined) {
    return undefined;
  }

  try {
    return truncateText(JSON.stringify(value), maxChars);
  } catch {
    return undefined;
  }
}

function extractMessages(payload: unknown): Array<Record<string, unknown>> {
  const record = asRecord(payload);
  const candidates = [
    record?.messages,
    record?.messageHistory,
    record?.conversation,
    asRecord(record?.prompt)?.messages,
    asRecord(record?.input)?.messages
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.flatMap((entry) => {
        const next = asRecord(entry);
        return next ? [next] : [];
      });
    }
  }

  return [];
}

function messageText(message: Record<string, unknown>) {
  const direct = readString(message.content) ?? readString(message.text);
  if (direct) {
    return direct;
  }

  const parts = Array.isArray(message.content) ? message.content : Array.isArray(message.parts) ? message.parts : [];
  const chunks = parts.flatMap((part) => {
    const record = asRecord(part);
    const text = readString(record?.text) ?? readString(record?.content);
    return text ? [text] : [];
  });

  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function messageRole(message: Record<string, unknown>) {
  return readString(message.role) ?? readString(message.author) ?? readString(asRecord(message.message)?.role);
}

function extractPromptContext(payload: unknown) {
  const messages = extractMessages(payload);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const current = messages[index];
    if (!current) {
      continue;
    }

    const role = messageRole(current);
    if (role !== "user") {
      continue;
    }

    const text = truncateText(messageText(current), 500);
    let preceding: string | undefined;

    for (let prior = index - 1; prior >= 0; prior -= 1) {
      const candidate = messages[prior];
      if (!candidate || messageRole(candidate) !== "assistant") {
        continue;
      }

      preceding = truncateText(messageText(candidate), 200);
      break;
    }

    if (!text && !preceding) {
      return null;
    }

    return { text, preceding };
  }

  return null;
}

function extractConversation(payload: unknown): ConversationTurn[] {
  return extractMessages(payload)
    .map((message) => {
      const role = messageRole(message);
      const content = truncateText(messageText(message), 500);
      return role && content ? { role, content } : null;
    })
    .flatMap((turn) => (turn ? [turn] : []))
    .slice(-8);
}

function summarizeToolArgs(event: unknown) {
  const record = asRecord(event);
  const toolName = readString(record?.toolName) ?? readString(record?.name) ?? "tool";
  const params = record?.params ?? record?.arguments ?? record?.args ?? record?.input;
  const summary = summarizeUnknown(params, 240);

  return truncateText(summary ? `${toolName} ${summary}` : toolName, 300);
}

function summarizeToolOutput(event: unknown) {
  const record = asRecord(event);
  return summarizeUnknown(record?.result ?? record?.output ?? record?.response ?? record?.content, 500);
}

function resolveRuntime(
  config: SherpaPluginConfig | undefined,
  params: { agentId?: string | undefined; caseId?: string | undefined }
) {
  const resolved = resolveSherpaPluginConfig(config, {
    agentId: detectAgentId(params)
  });

  let runtime = runtimeCache.get(resolved.storeRoot);

  if (!runtime || backendNeedsRefresh(runtime.resolved, resolved)) {
    runtime = {
      resolved,
      backend: createSherpaBackend(resolved)
    };
    runtimeCache.set(resolved.storeRoot, runtime);
  }

  runtime.resolved = resolved;
  resolvedConfigCache.set(resolved.storeRoot, resolved);

  return runtime;
}

function enqueueCapture(
  maintenance: ReturnType<typeof createSherpaMaintenanceRuntime>,
  runtime: ReturnType<typeof resolveRuntime>,
  event: SherpaEventInput | null
) {
  if (!event) {
    return;
  }

  maintenance.enqueueCapture(runtime, event);
}

function unavailableResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return jsonResult({
    backend: "sherpa",
    ok: false,
    error: {
      code: "backend_unavailable",
      message
    }
  });
}

function resolveCaptureCaseId(
  decision: ReturnType<typeof resolveSherpaPolicyDecision>,
  params: {
    sessionId?: string | undefined;
    sessionKey?: string | undefined;
    runId?: string | undefined;
    toolCallId?: string | undefined;
    timestamp?: number | undefined;
  }
) {
  if (!decision.stateless) {
    return undefined;
  }

  return buildStatelessCaseId({
    policy: decision,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    toolCallId: params.toolCallId,
    timestamp: params.timestamp
  });
}

const sherpaConfigZodSchema = z.object({
  transport: z.object({
    mode: z.enum(["embedded", "stdio", "http"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    baseUrl: z.string().optional(),
    manageProcess: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    env: z.record(z.string(), z.string()).optional()
  }).optional(),
  store: z.object({
    root: z.string().optional()
  }).optional(),
  ledger: z.object({
    redactRawText: z.boolean().optional(),
    maxMetaBytes: z.number().optional()
  }).optional(),
  order: z.object({
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    backoff: z.boolean().optional(),
    minSupport: z.number().optional()
  }).optional(),
  advisory: z.object({
    enabled: z.boolean().optional(),
    injectThreshold: z.number().optional(),
    maxCandidates: z.number().optional(),
    maxRisks: z.number().optional(),
    maxChars: z.number().optional(),
    interpreterModel: z.string().optional()
  }).optional(),
  capture: z.object({
    messages: z.boolean().optional(),
    tools: z.boolean().optional(),
    browser: z.boolean().optional(),
    web: z.boolean().optional(),
    automation: z.boolean().optional(),
    memoryWrites: z.boolean().optional()
  }).optional(),
  taxonomy: z.object({
    rules: z.array(z.object({
      match: z.object({
        kind: z.enum(["message", "session", "task", "tool"]).optional(),
        sourcePattern: z.string().optional(),
        typePattern: z.string().optional()
      }).optional(),
      rewrite: z.object({
        type: z.string().optional(),
        source: z.string().optional()
      }).optional(),
      drop: z.boolean().optional()
    })).optional()
  }).optional(),
  scope: z.object({
    default: z.enum(["allow", "deny"]).optional(),
    rules: z.array(z.object({
      action: z.enum(["allow", "deny"]),
      match: z.object({
        chatType: z.string().optional(),
        sessionKeyPrefix: z.string().optional(),
        normalizedKeyPrefix: z.string().optional()
      }).optional()
    })).optional()
  }).optional(),
  update: z.object({
    onBoot: z.boolean().optional(),
    interval: z.string().optional(),
    debounceMs: z.number().optional(),
    commandTimeoutMs: z.number().optional(),
    rebuildOnVersionChange: z.boolean().optional()
  }).optional(),
  ignoreSessionPatterns: z.array(z.string()).optional(),
  statelessSessionPatterns: z.array(z.string()).optional()
});

const sherpaPluginConfigSchema = buildPluginConfigSchema(sherpaConfigZodSchema, {
  uiHints: {
    "advisory.enabled": { label: "Enable advisory", help: "Inject procedural hints before major decision turns" },
    "advisory.injectThreshold": { label: "Advisory confidence threshold", help: "Minimum confidence to inject advisory (0-1)" },
    "order.default": { label: "Default graph order", help: "Default suffix length for workflow state matching" },
    "update.interval": { label: "Maintenance interval", help: "How often to run background graph maintenance (e.g. 5m)" },
    "scope.default": { label: "Default scope", help: "Allow or deny event capture by default" },
    "ledger.redactRawText": { label: "Redact raw text", help: "Strip raw message text from ledger events" },
    "transport.mode": { label: "Transport mode", help: "How the plugin communicates with the Sherpa engine (embedded, stdio, http)" }
  }
});

export default definePluginEntry({
  id: "sherpa",
  name: "Sherpa",
  description: "Procedural workflow memory for OpenClaw",
  configSchema: sherpaPluginConfigSchema,
  register(api) {
    const pluginConfig = (api.config?.plugins?.entries?.sherpa?.config ?? {}) as SherpaPluginConfig;
    const baseResolved = resolveSherpaPluginConfig(pluginConfig);
    const caseRouter = new SherpaCaseRouter(baseResolved);
    const daemonSupervisor = createManagedDaemonSupervisor();
    const maintenance = createSherpaMaintenanceRuntime({
      logger: api.logger,
      listRuntimes: () =>
        [...runtimeCache.entries()].flatMap(([storeRoot, runtime]) => {
          const resolved = resolvedConfigCache.get(storeRoot);
          return resolved ? [{ backend: runtime.backend, resolved }] : [];
        }),
      flushDebounceMs: (resolved) => resolved.update.debounceMs,
      maintenanceIntervalMs: () => baseResolved.update.intervalMs,
      onBoot: () => baseResolved.update.onBoot
    });

    api.registerService({
      id: "sherpa-maintenance",
      async start() {
        const mainRuntime = resolveRuntime(pluginConfig, { agentId: "main" });

        try {
          await daemonSupervisor.ensureReady(mainRuntime.resolved);
          await mainRuntime.backend.init();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.logger.warn(`Sherpa init skipped: ${message}`);
        }

        maintenance.start();
      },
      async stop() {
        await maintenance.stop();
        await daemonSupervisor.stopAll();
      }
    });

    api.on("session_start", (event, ctx) => {
      const decision = resolveSherpaPolicyDecision(baseResolved, {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey
      });
      if (!decision.allowed) {
        return;
      }

      const runtime = resolveRuntime(pluginConfig, ctx);
      const caseId =
        caseRouter.resolveActiveCaseId({
          policy: decision,
          sessionId: event.sessionId,
          sessionKey: ctx.sessionKey
        }) ?? resolveCaptureCaseId(decision, { ...event, ...ctx });
      enqueueCapture(
        maintenance,
        runtime,
        buildSessionStartEvent(runtime.resolved, { ...event, ...ctx }, { caseId })
      );
    });

    api.on("session_end", (event, ctx) => {
      const decision = resolveSherpaPolicyDecision(baseResolved, {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey
      });
      if (!decision.allowed) {
        return;
      }

      if (ctx.sessionKey) {
        promptContextCache.delete(ctx.sessionKey);
      }

      const runtime = resolveRuntime(pluginConfig, ctx);
      const terminal = caseRouter.closeActiveCase({
        sessionKey: ctx.sessionKey,
        reason: "session-end"
      });
      if (terminal) {
        enqueueCapture(
          maintenance,
          runtime,
          buildTaskEndEvent(
            runtime.resolved,
            {
              agentId: decision.agentId,
              sessionId: event.sessionId,
              sessionKey: ctx.sessionKey,
              title: terminal.title,
              slug: terminal.slug,
              terminalType: terminal.terminalType,
              reason: terminal.reason,
              timestamp: Date.now()
            },
            { caseId: terminal.caseId }
          )
        );
      }
      const caseId =
        terminal?.caseId ??
        caseRouter.resolveActiveCaseId({
          policy: decision,
          sessionId: event.sessionId,
          sessionKey: ctx.sessionKey
        }) ??
        resolveCaptureCaseId(decision, { ...event, ...ctx });
      enqueueCapture(
        maintenance,
        runtime,
        buildSessionEndEvent(runtime.resolved, { ...event, ...ctx }, { caseId })
      );
    });

    api.on("before_dispatch", (event, ctx) => {
      const decision = resolveSherpaPolicyDecision(baseResolved, {
        sessionKey: ctx.sessionKey,
        channel: event.channel,
        isGroup: event.isGroup
      });
      if (!decision.allowed) {
        return;
      }

      const dispatchRouting = caseRouter.routeDispatch({
        policy: decision,
        sessionKey: ctx.sessionKey,
        content: event.content,
        timestamp: event.timestamp
      });

      const boundary = dispatchRouting.boundary;
      const terminal = dispatchRouting.terminal;
      if (terminal) {
        const terminalRuntime = resolveRuntime(pluginConfig, {
          agentId: decision.agentId,
          caseId: terminal.caseId
        });
        enqueueCapture(
          maintenance,
          terminalRuntime,
          buildTaskEndEvent(
            terminalRuntime.resolved,
            {
              agentId: decision.agentId,
              sessionKey: ctx.sessionKey,
              title: terminal.title,
              slug: terminal.slug,
              terminalType: terminal.terminalType,
              reason: terminal.reason,
              timestamp: event.timestamp
            },
            { caseId: terminal.caseId }
          )
        );
      }
      if (boundary) {
        const taskRuntime = resolveRuntime(pluginConfig, {
          agentId: decision.agentId,
          caseId: boundary.caseId
        });
        enqueueCapture(
          maintenance,
          taskRuntime,
          buildTaskStartEvent(
            taskRuntime.resolved,
            {
              agentId: decision.agentId,
              sessionKey: ctx.sessionKey,
              title: boundary.title,
              slug: boundary.slug,
              reason: boundary.reason,
              timestamp: event.timestamp
            },
            { caseId: boundary.caseId }
          )
        );
      }

      const activeCaseId =
        dispatchRouting.caseId ??
        resolveCaptureCaseId(decision, { ...event, ...ctx });

      const eventRecord = buildDispatchEvent(
        baseResolved,
        {
          ...event,
          ...ctx,
          ...(ctx.sessionKey ? promptContextCache.get(ctx.sessionKey) ?? {} : {})
        },
        { caseId: activeCaseId }
      );
      if (!eventRecord) {
        return;
      }

      const runtime = resolveRuntime(pluginConfig, eventRecord);
      enqueueCapture(maintenance, runtime, eventRecord);
    });

    api.on("before_tool_call", (event, ctx) => {
      const decision = resolveSherpaPolicyDecision(baseResolved, {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey
      });
      if (!decision.allowed) {
        return;
      }

      const runtime = resolveRuntime(pluginConfig, ctx);
      const caseId =
        caseRouter.resolveActiveCaseId({
          policy: decision,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          toolCallId: ctx.toolCallId
        }) ?? resolveCaptureCaseId(decision, { ...event, ...ctx });
      enqueueCapture(
        maintenance,
        runtime,
        buildToolStartEvent(
          runtime.resolved,
          {
            ...event,
            ...ctx,
            ...(summarizeToolArgs(event) ? { toolArgsSummary: summarizeToolArgs(event) } : {})
          },
          { caseId }
        )
      );
    });

    api.on("before_prompt_build", async (event, ctx) => {
      const decision = resolveSherpaPolicyDecision(baseResolved, {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        channel: ctx.channelId
      });
      if (!decision.allowed || !baseResolved.advisory.enabled || !ctx.sessionKey) {
        return;
      }

      if (ctx.trigger && ctx.trigger !== "user") {
        return;
      }

      if (ctx.sessionKey) {
        const promptContext = extractPromptContext(event ?? ctx);
        if (promptContext) {
          promptContextCache.set(ctx.sessionKey, {
            ...(promptContext.text ? { text: promptContext.text } : {}),
            ...(promptContext.preceding ? { preceding: promptContext.preceding } : {})
          });
        }
      }

      const caseId =
        caseRouter.resolveActiveCaseId({
          policy: decision,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId
        }) ??
        resolveCaptureCaseId(decision, {
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId
        }) ?? `session:${ctx.sessionKey}`;

      try {
        const runtime = resolveRuntime(pluginConfig, {
          agentId: decision.agentId,
          caseId
        });
        await daemonSupervisor.ensureReady(runtime.resolved);
        const engine = runtime.backend;
        const [state, signalsResult] = await Promise.all([
          engine.workflowState(caseId),
          engine.workflowSignals(caseId, baseResolved.advisory.maxCandidates)
        ]);

        const strongSignals = signalsResult.signals.filter((signal) => {
          const responseCount = Object.values(signal.userResponseDist).reduce((sum, value) => sum + value, 0);
          return signal.probability >= baseResolved.advisory.injectThreshold || signal.support >= 2 || responseCount >= 2;
        });

        if (state.confidence < baseResolved.advisory.injectThreshold || strongSignals.length === 0) {
          return;
        }

        const advisory = await interpretAdvisory({
          config: baseResolved,
          signals: strongSignals,
          conversation: extractConversation(event ?? ctx)
        });

        if (!advisory) {
          return;
        }

        try {
          await runtime.backend.trackAdvisoryInjection();
        } catch {
          // Non-critical — don't block the advisory
        }

        return {
          prependContext: advisory
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn(`Sherpa advisory skipped: ${message}`);
        return;
      }
    });

    api.on("after_tool_call", (event, ctx) => {
      const decision = resolveSherpaPolicyDecision(baseResolved, {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey
      });
      if (!decision.allowed) {
        return;
      }

      const runtime = resolveRuntime(pluginConfig, ctx);
      const caseId =
        caseRouter.resolveActiveCaseId({
          policy: decision,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          toolCallId: ctx.toolCallId
        }) ?? resolveCaptureCaseId(decision, { ...event, ...ctx });
      enqueueCapture(
        maintenance,
        runtime,
        buildToolFinishEvent(
          runtime.resolved,
          {
            ...event,
            ...ctx,
            ...(summarizeToolArgs(event) ? { toolArgsSummary: summarizeToolArgs(event) } : {}),
            ...(summarizeToolOutput(event) ? { outputSnippet: summarizeToolOutput(event) } : {})
          },
          { caseId }
        )
      );
    });

    api.registerTool({
      name: "workflow_state",
      label: "Workflow State",
      description: "Infer the current Sherpa workflow state for a case",
      parameters: Type.Object({
        caseId: Type.String(),
        agentId: Type.Optional(Type.String()),
        maxOrder: Type.Optional(Type.Integer({ minimum: 1 }))
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.workflowState(params.caseId, params.maxOrder));
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_next",
      label: "Workflow Next",
      description: "Suggest likely next workflow events from the current path",
      parameters: Type.Object({
        caseId: Type.String(),
        agentId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1 }))
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.workflowNext(params.caseId, params.limit ?? 5));
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_signals",
      label: "Workflow Signals",
      description: "Return raw behavioral signals from the current path",
      parameters: Type.Object({
        caseId: Type.String(),
        agentId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1 }))
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.workflowSignals(params.caseId, params.limit ?? 5));
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_risks",
      label: "Workflow Risks",
      description: "Return likely failure or stall branches from the current path",
      parameters: Type.Object({
        caseId: Type.String(),
        agentId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1 }))
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.workflowRisks(params.caseId, params.limit ?? 3));
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_recall",
      label: "Workflow Recall",
      description: "Recall similar historical workflow paths and continuations",
      parameters: Type.Object({
        caseId: Type.String(),
        agentId: Type.Optional(Type.String()),
        mode: Type.Optional(Type.Union([Type.Literal("successful"), Type.Literal("failed"), Type.Literal("any")])),
        limit: Type.Optional(Type.Integer({ minimum: 1 }))
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.workflowRecall(params.caseId, params.mode ?? "successful", params.limit ?? 3));
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_status",
      label: "Workflow Status",
      description: "Show Sherpa backend health and freshness status",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String())
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const status = await runtime.backend.status();
          return jsonResult({
            ...status,
            advisoryEnabled: runtime.resolved.advisory.enabled,
            transport: {
              mode: runtime.resolved.transport.mode,
              ...(runtime.resolved.transport.mode === "stdio"
                ? {
                    command: runtime.resolved.transport.command,
                    args: runtime.resolved.transport.args,
                    manageProcess: runtime.resolved.transport.manageProcess,
                    timeoutMs: runtime.resolved.transport.timeoutMs
                  }
                : runtime.resolved.transport.mode === "http"
                  ? {
                      baseUrl: runtime.resolved.transport.baseUrl,
                      manageProcess: runtime.resolved.transport.manageProcess,
                      timeoutMs: runtime.resolved.transport.timeoutMs
                    }
                : {})
            },
            capture: runtime.resolved.capture,
            caseSplitting: {
              enabled: runtime.resolved.caseSplitting.enabled,
              autoEnabled: runtime.resolved.caseSplitting.auto.enabled,
              markerCount: runtime.resolved.caseSplitting.markers.length,
              completeMarkerCount: runtime.resolved.caseSplitting.completeMarkers.length,
              failMarkerCount: runtime.resolved.caseSplitting.failMarkers.length
            },
            taxonomy: {
              ruleCount: runtime.resolved.taxonomy.rules.length
            },
            scope: {
              defaultAction: runtime.resolved.scope.defaultAction,
              ruleCount: runtime.resolved.scope.rules.length,
              statelessPatternCount: runtime.resolved.statelessSessionPatterns.length,
              ignorePatternCount: runtime.resolved.ignoreSessionPatterns.length
            }
          });
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_analytics",
      label: "Workflow Analytics",
      description: "Summarize cross-case hot transitions and systemic failure or stall branches",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1 }))
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.analyticsReport({ limit: params.limit ?? 10 }));
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_doctor",
      label: "Workflow Doctor",
      description: "Run Sherpa health checks",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String())
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.doctor());
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_rebuild",
      label: "Workflow Rebuild",
      description: "Rebuild Sherpa's derived graph from the canonical ledger",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String())
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          await engine.rebuild();
          return jsonResult(await engine.status());
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_export",
      label: "Workflow Export",
      description: "Export a JSON snapshot of the current Sherpa state",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String())
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.exportSnapshot());
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_gc",
      label: "Workflow GC",
      description: "Run Sherpa graph vacuum and temp/export cleanup",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String())
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.gc());
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_taxonomy",
      label: "Workflow Taxonomy",
      description: "Inspect Sherpa event alphabet cardinality and recent drift metrics",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String()),
        recentDays: Type.Optional(Type.Number({ minimum: 0 })),
        rareSupport: Type.Optional(Type.Number({ minimum: 0 })),
        limit: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(
            await engine.taxonomyReport({
              ...(typeof params.recentDays === "number" ? { recentDays: params.recentDays } : {}),
              ...(typeof params.rareSupport === "number" ? { rareSupport: params.rareSupport } : {}),
              ...(typeof params.limit === "number" ? { limit: params.limit } : {})
            })
          );
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool({
      name: "workflow_metrics",
      label: "Workflow Metrics",
      description: "Collect adoption, quality, efficiency, and reliability metrics for the Sherpa instance",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String())
      }),
      async execute(_id, params) {
        try {
          const runtime = resolveRuntime(pluginConfig, params);
          await daemonSupervisor.ensureReady(runtime.resolved);
          const engine = runtime.backend;
          return jsonResult(await engine.collectMetrics());
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

    api.registerTool(
      {
        name: "workflow_consolidate",
        label: "Workflow Consolidate",
        description: "Run sleep-cycle consolidation: LLM-classify unconsolidated events, enrich types, and rebuild the graph with a richer taxonomy",
        parameters: Type.Object({
          agentId: Type.Optional(Type.String()),
          batchSize: Type.Optional(Type.Number({ minimum: 1, description: "Events per LLM call (default: 50)" })),
          dryRun: Type.Optional(Type.Boolean({ description: "Preview enrichments without writing" })),
          reclassify: Type.Optional(Type.Boolean({ description: "Re-process already-consolidated events" })),
          model: Type.Optional(Type.String({ description: "Override LLM model" })),
          provider: Type.Optional(Type.String({ description: "Override LLM provider" }))
        }),
        async execute(_id, params) {
          try {
            const runtime = resolveRuntime(pluginConfig, params);
            await daemonSupervisor.ensureReady(runtime.resolved);
            const engine = runtime.backend;

            const { resolveOpenClawLlmConfig, createOpenClawClassifier } = await import("./llm-classify.js");

            const llmConfig = await resolveOpenClawLlmConfig({
              modelAuth: api.runtime?.modelAuth as import("./llm-classify.js").ModelAuthRuntime | undefined,
              agentDefaults: api.runtime?.agent?.defaults as import("./llm-classify.js").AgentDefaults | undefined,
              config: api.config,
              preferredModel: params.model,
              preferredProvider: params.provider
            });

            const classify = createOpenClawClassifier(llmConfig);

            const result = await engine.consolidate({
              classify,
              model: `${llmConfig.provider}/${llmConfig.model}`,
              batchSize: params.batchSize,
              dryRun: params.dryRun,
              reclassify: params.reclassify
            });

            return jsonResult(result);
          } catch (error) {
            return unavailableResult(error);
          }
        }
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "workflow_ingest_event",
        label: "Workflow Ingest Event",
        description: "Append a canonical event into Sherpa's ledger and rebuild the graph",
        parameters: Type.Object({
          event: Type.Object({
            eventId: Type.Optional(Type.String()),
            schemaVersion: Type.Optional(Type.Literal(1)),
            agentId: Type.Optional(Type.String()),
            caseId: Type.String(),
            ts: Type.Optional(Type.String()),
            source: Type.String(),
            type: Type.String(),
            actor: Type.Optional(Type.String()),
            outcome: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("unknown")])),
            labels: Type.Optional(Type.Array(Type.String())),
            entities: Type.Optional(Type.Array(Type.String())),
            metrics: Type.Optional(Type.Record(Type.String(), Type.Number())),
            meta: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
          })
        }),
        async execute(_id, params) {
          try {
            const runtime = resolveRuntime(pluginConfig, params.event);
            await daemonSupervisor.ensureReady(runtime.resolved);
            const engine = runtime.backend;
            return jsonResult(await engine.ingest(params.event as SherpaEventInput));
          } catch (error) {
            return unavailableResult(error);
          }
        }
      },
      { optional: true }
    );
  }
});
