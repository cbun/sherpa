import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { SherpaClient, type SherpaSdkAgentOptions } from "@sherpa/sdk";
import * as z from "zod/v4";

export interface SherpaMcpOptions extends SherpaSdkAgentOptions {
  rootDir?: string;
}

function readArgValue(argv: string[], flag: string) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

function readOptionalNumber(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveSherpaMcpOptions(argv = process.argv.slice(2)): SherpaMcpOptions {
  const rootDir = readArgValue(argv, "--root");
  const agentId = readArgValue(argv, "--agent-id");
  const baseDir = readArgValue(argv, "--base-dir");
  const defaultOrder = readOptionalNumber(readArgValue(argv, "--default-order"));
  const minOrder = readOptionalNumber(readArgValue(argv, "--min-order"));
  const maxOrder = readOptionalNumber(readArgValue(argv, "--max-order"));
  const minSupport = readOptionalNumber(readArgValue(argv, "--min-support"));

  const options: SherpaMcpOptions = {
    ...(rootDir !== undefined ? { rootDir } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(baseDir !== undefined ? { baseDir } : {}),
    ...(defaultOrder !== undefined ? { defaultOrder } : {}),
    ...(minOrder !== undefined ? { minOrder } : {}),
    ...(maxOrder !== undefined ? { maxOrder } : {}),
    ...(minSupport !== undefined ? { minSupport } : {})
  };

  return options;
}

function createClient(options: SherpaMcpOptions) {
  if (options.rootDir) {
    return new SherpaClient({
      rootDir: options.rootDir,
      ...(options.defaultOrder !== undefined ? { defaultOrder: options.defaultOrder } : {}),
      ...(options.minOrder !== undefined ? { minOrder: options.minOrder } : {}),
      ...(options.maxOrder !== undefined ? { maxOrder: options.maxOrder } : {}),
      ...(options.minSupport !== undefined ? { minSupport: options.minSupport } : {})
    });
  }

  return SherpaClient.forAgent(options);
}

export function formatMcpJsonResult(result: unknown) {
  const structuredContent = { result };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent
  };
}

export function createSherpaMcpServer(options: SherpaMcpOptions = {}) {
  const client = createClient(options);
  const server = new McpServer({
    name: "sherpa-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "workflow_state",
    {
      description: "Infer the current Sherpa workflow state for a case",
      inputSchema: {
        caseId: z.string(),
        maxOrder: z.number().int().positive().optional()
      }
    },
    async ({ caseId, maxOrder }) => formatMcpJsonResult(await client.workflowState(caseId, maxOrder))
  );

  server.registerTool(
    "workflow_next",
    {
      description: "Suggest likely next workflow events from the current path",
      inputSchema: {
        caseId: z.string(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ caseId, limit }) => formatMcpJsonResult(await client.workflowNext(caseId, limit))
  );

  server.registerTool(
    "workflow_risks",
    {
      description: "Return likely failure or stall branches from the current path",
      inputSchema: {
        caseId: z.string(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ caseId, limit }) => formatMcpJsonResult(await client.workflowRisks(caseId, limit))
  );

  server.registerTool(
    "workflow_recall",
    {
      description: "Recall similar historical workflow paths and continuations",
      inputSchema: {
        caseId: z.string(),
        mode: z.enum(["successful", "failed", "any"]).optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ caseId, mode, limit }) => formatMcpJsonResult(await client.workflowRecall(caseId, mode, limit))
  );

  server.registerTool(
    "workflow_status",
    {
      description: "Show Sherpa backend health and freshness status"
    },
    async () => formatMcpJsonResult(await client.status())
  );

  server.registerTool(
    "workflow_doctor",
    {
      description: "Run Sherpa health checks"
    },
    async () => formatMcpJsonResult(await client.doctor())
  );

  server.registerTool(
    "workflow_rebuild",
    {
      description: "Rebuild Sherpa's derived graph from the canonical ledger"
    },
    async () => {
      await client.rebuild();
      return formatMcpJsonResult(await client.status());
    }
  );

  server.registerTool(
    "workflow_gc",
    {
      description: "Run Sherpa graph vacuum and temp/export cleanup"
    },
    async () => formatMcpJsonResult(await client.gc())
  );

  server.registerTool(
    "workflow_export",
    {
      description: "Export a JSON snapshot of the current Sherpa state"
    },
    async () => formatMcpJsonResult(await client.exportSnapshot())
  );

  server.registerTool(
    "workflow_import",
    {
      description: "Import a previously exported Sherpa snapshot (JSON file)",
      inputSchema: {
        snapshotPath: z.string()
      }
    },
    async ({ snapshotPath }) => formatMcpJsonResult(await client.importSnapshot(snapshotPath))
  );

  server.registerTool(
    "workflow_ingest_event",
    {
      description: "Append a canonical event into Sherpa's ledger",
      inputSchema: {
        event: z.object({
          eventId: z.string().optional(),
          schemaVersion: z.literal(1).optional(),
          agentId: z.string().optional(),
          caseId: z.string(),
          ts: z.string().optional(),
          source: z.string(),
          type: z.string(),
          actor: z.string().optional(),
          outcome: z.enum(["success", "failure", "unknown"]).optional(),
          labels: z.array(z.string()).optional(),
          entities: z.array(z.string()).optional(),
          metrics: z.record(z.string(), z.number()).optional(),
          meta: z.record(z.string(), z.unknown()).optional()
        })
      }
    },
    async ({ event }) => formatMcpJsonResult(await client.ingest(event))
  );

  server.registerTool(
    "workflow_ingest_batch",
    {
      description: "Append multiple canonical events into Sherpa's ledger",
      inputSchema: {
        events: z.array(
          z.object({
            eventId: z.string().optional(),
            schemaVersion: z.literal(1).optional(),
            agentId: z.string().optional(),
            caseId: z.string(),
            ts: z.string().optional(),
            source: z.string(),
            type: z.string(),
            actor: z.string().optional(),
            outcome: z.enum(["success", "failure", "unknown"]).optional(),
            labels: z.array(z.string()).optional(),
            entities: z.array(z.string()).optional(),
            metrics: z.record(z.string(), z.number()).optional(),
            meta: z.record(z.string(), z.unknown()).optional()
          })
        )
      }
    },
    async ({ events }) => formatMcpJsonResult(await client.ingestBatch(events))
  );

  server.registerTool(
    "workflow_metrics",
    {
      description: "Collect adoption, quality, efficiency, and reliability metrics for the Sherpa instance",
      inputSchema: {}
    },
    async () => formatMcpJsonResult(await client.collectMetrics())
  );

  return {
    client,
    server
  };
}

export async function runSherpaMcpServer(options: SherpaMcpOptions = {}) {
  const transport = new StdioServerTransport();
  const { server } = createSherpaMcpServer(options);
  await server.connect(transport);
}
