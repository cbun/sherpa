import { SherpaEngine, type SherpaEventInput } from "@sherpa/core";
import { Type } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/core";

import {
  buildDispatchEvent,
  buildSessionEndEvent,
  buildSessionStartEvent,
  buildToolFinishEvent,
  buildToolStartEvent
} from "./capture.js";
import { resolveSherpaPluginConfig, type SherpaPluginConfig } from "./config.js";
import { createSherpaMaintenanceRuntime } from "./maintenance.js";

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

const engineCache = new Map<string, SherpaEngine>();
const resolvedConfigCache = new Map<string, ReturnType<typeof resolveSherpaPluginConfig>>();

function resolveRuntime(
  config: SherpaPluginConfig | undefined,
  params: { agentId?: string | undefined; caseId?: string | undefined }
) {
  const resolved = resolveSherpaPluginConfig(config, {
    agentId: detectAgentId(params)
  });

  let engine = engineCache.get(resolved.storeRoot);

  if (!engine) {
    engine = new SherpaEngine(resolved.engine);
    engineCache.set(resolved.storeRoot, engine);
    resolvedConfigCache.set(resolved.storeRoot, resolved);
  }

  return {
    resolved,
    engine
  };
}

function createEngine(
  config: SherpaPluginConfig | undefined,
  params: { agentId?: string | undefined; caseId?: string | undefined }
) {
  return resolveRuntime(config, params).engine;
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

export default definePluginEntry({
  id: "sherpa",
  name: "Sherpa",
  description: "Procedural workflow memory for OpenClaw",
  register(api) {
    const pluginConfig = (api.config?.plugins?.entries?.sherpa?.config ?? {}) as SherpaPluginConfig;
    const baseResolved = resolveSherpaPluginConfig(pluginConfig);
    const maintenance = createSherpaMaintenanceRuntime({
      logger: api.logger,
      listRuntimes: () =>
        [...engineCache.entries()].flatMap(([storeRoot, engine]) => {
          const resolved = resolvedConfigCache.get(storeRoot);
          return resolved ? [{ engine, resolved }] : [];
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
          await mainRuntime.engine.init();
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
      const runtime = resolveRuntime(pluginConfig, ctx);
      enqueueCapture(maintenance, runtime, buildSessionStartEvent(runtime.resolved, { ...event, ...ctx }));
    });

    api.on("session_end", (event, ctx) => {
      const runtime = resolveRuntime(pluginConfig, ctx);
      enqueueCapture(maintenance, runtime, buildSessionEndEvent(runtime.resolved, { ...event, ...ctx }));
    });

    api.on("before_dispatch", (event, ctx) => {
      const eventRecord = buildDispatchEvent(baseResolved, { ...event, ...ctx });
      if (!eventRecord) {
        return;
      }

      const runtime = resolveRuntime(pluginConfig, eventRecord);
      enqueueCapture(maintenance, runtime, eventRecord);
    });

    api.on("before_tool_call", (event, ctx) => {
      const runtime = resolveRuntime(pluginConfig, ctx);
      enqueueCapture(maintenance, runtime, buildToolStartEvent(runtime.resolved, { ...event, ...ctx }));
    });

    api.on("after_tool_call", (event, ctx) => {
      const runtime = resolveRuntime(pluginConfig, ctx);
      enqueueCapture(maintenance, runtime, buildToolFinishEvent(runtime.resolved, { ...event, ...ctx }));
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
        const engine = createEngine(pluginConfig, params);
        return jsonResult(await engine.workflowState(params.caseId, params.maxOrder));
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
        const engine = createEngine(pluginConfig, params);
        return jsonResult(await engine.workflowNext(params.caseId, params.limit ?? 5));
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
        const engine = createEngine(pluginConfig, params);
        return jsonResult(await engine.workflowRisks(params.caseId, params.limit ?? 3));
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
        const engine = createEngine(pluginConfig, params);
        return jsonResult(await engine.workflowRecall(params.caseId, params.mode ?? "successful", params.limit ?? 3));
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
        const engine = createEngine(pluginConfig, params);
        return jsonResult(await engine.status());
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
          const engine = createEngine(pluginConfig, params.event);
          return jsonResult(await engine.ingest(params.event as SherpaEventInput));
        }
      },
      { optional: true }
    );
  }
});
