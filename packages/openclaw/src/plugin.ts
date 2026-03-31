import type { SherpaEventInput } from "@sherpa/core";
import { Type } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
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
import { buildSherpaAdvisory } from "./advisory.js";
import { createSherpaBackend, type SherpaPluginRuntime } from "./backend.js";
import { SherpaCaseRouter } from "./cases.js";
import { resolveSherpaPluginConfig, type SherpaPluginConfig } from "./config.js";
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

function resolveRuntime(
  config: SherpaPluginConfig | undefined,
  params: { agentId?: string | undefined; caseId?: string | undefined }
) {
  const resolved = resolveSherpaPluginConfig(config, {
    agentId: detectAgentId(params)
  });

  let runtime = runtimeCache.get(resolved.storeRoot);

  if (!runtime) {
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

function createEngine(
  config: SherpaPluginConfig | undefined,
  params: { agentId?: string | undefined; caseId?: string | undefined }
) {
  return resolveRuntime(config, params).backend;
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

export default definePluginEntry({
  id: "sherpa",
  name: "Sherpa",
  description: "Procedural workflow memory for OpenClaw",
  register(api) {
    const pluginConfig = (api.config?.plugins?.entries?.sherpa?.config ?? {}) as SherpaPluginConfig;
    const baseResolved = resolveSherpaPluginConfig(pluginConfig);
    const caseRouter = new SherpaCaseRouter(baseResolved);
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
          await mainRuntime.backend.init();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.logger.warn(`Sherpa init skipped: ${message}`);
        }

        maintenance.start();
      },
      async stop() {
        await maintenance.stop();
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
        { ...event, ...ctx },
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
        buildToolStartEvent(runtime.resolved, { ...event, ...ctx }, { caseId })
      );
    });

    api.on("before_prompt_build", async (_event, ctx) => {
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
        const engine = createEngine(pluginConfig, {
          agentId: decision.agentId,
          caseId
        });
        const [state, next, risks] = await Promise.all([
          engine.workflowState(caseId),
          engine.workflowNext(caseId, baseResolved.advisory.maxCandidates),
          engine.workflowRisks(caseId, baseResolved.advisory.maxRisks)
        ]);
        const advisory = buildSherpaAdvisory({
          config: baseResolved,
          state,
          next,
          risks
        });

        if (!advisory) {
          return;
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
        buildToolFinishEvent(runtime.resolved, { ...event, ...ctx }, { caseId })
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
          const engine = createEngine(pluginConfig, params);
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
          const engine = createEngine(pluginConfig, params);
          return jsonResult(await engine.workflowNext(params.caseId, params.limit ?? 5));
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
          const engine = createEngine(pluginConfig, params);
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
          const engine = createEngine(pluginConfig, params);
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
      name: "workflow_doctor",
      label: "Workflow Doctor",
      description: "Run Sherpa health checks",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String())
      }),
      async execute(_id, params) {
        try {
          const engine = createEngine(pluginConfig, params);
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
          const engine = createEngine(pluginConfig, params);
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
          const engine = createEngine(pluginConfig, params);
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
          const engine = createEngine(pluginConfig, params);
          return jsonResult(await engine.gc());
        } catch (error) {
          return unavailableResult(error);
        }
      }
    });

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
            const engine = createEngine(pluginConfig, params.event);
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
