import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { SherpaEngine, type SherpaEventInput, type WorkflowRecallMode } from "@sherpa/core";
import { Command, type Command as CommandInstance } from "commander";

import { assertValidationThresholds, validateDatasetFile } from "./validate.js";

function defaultRoot() {
  return path.join(process.cwd(), ".sherpa");
}

function parseInteger(value: string, label: string) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}

function parseRatio(value: string, label: string) {
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }

  return parsed;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function resolveRoot(command: CommandInstance) {
  let current: CommandInstance | null = command;

  while (current) {
    const options = current.opts<{ root?: string }>();

    if (options.root) {
      return options.root;
    }

    current = current.parent;
  }

  return defaultRoot();
}

function createEngine(command: CommandInstance) {
  const options = command.optsWithGlobals<{ root?: string; defaultOrder?: string; minOrder?: string; maxOrder?: string; minSupport?: string }>();
  return createEngineFromValues(options);
}

function createEngineFromValues(options: {
  root?: string;
  defaultOrder?: string;
  minOrder?: string;
  maxOrder?: string;
  minSupport?: string;
}) {

  const engineOptions: ConstructorParameters<typeof SherpaEngine>[0] = {
    rootDir: options.root ?? defaultRoot()
  };

  if (options.defaultOrder) {
    engineOptions.defaultOrder = parseInteger(options.defaultOrder, "--default-order");
  }

  if (options.minOrder) {
    engineOptions.minOrder = parseInteger(options.minOrder, "--min-order");
  }

  if (options.maxOrder) {
    engineOptions.maxOrder = parseInteger(options.maxOrder, "--max-order");
  }

  if (options.minSupport) {
    engineOptions.minSupport = parseInteger(options.minSupport, "--min-support");
  }

  return new SherpaEngine(engineOptions);
}

async function readEventInput(file?: string): Promise<SherpaEventInput> {
  const input = file ? await fs.readFile(file, "utf8") : await readStdin();
  return JSON.parse(input) as SherpaEventInput;
}

async function readEventBatchInput(file?: string): Promise<SherpaEventInput[]> {
  const input = file ? await fs.readFile(file, "utf8") : await readStdin();
  return JSON.parse(input) as SherpaEventInput[];
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseRecallMode(mode: string): WorkflowRecallMode {
  if (mode === "successful" || mode === "failed" || mode === "any") {
    return mode;
  }

  throw new Error("workflow-recall --mode must be one of: successful, failed, any");
}

async function readJsonBody(request: import("node:http").IncomingMessage) {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    method?: string;
    params?: Record<string, unknown>;
  };
}

function writeJson(response: import("node:http").ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function executeRpc(engine: SherpaEngine, method: string, params: Record<string, unknown> = {}) {
  switch (method) {
    case "ingest":
      return engine.ingest(params.event as SherpaEventInput);
    case "ingestBatch":
      return engine.ingestBatch((params.events as SherpaEventInput[]) ?? []);
    case "rebuild":
      await engine.rebuild();
      return engine.status();
    case "status":
      return engine.status();
    case "doctor":
      return engine.doctor();
    case "exportSnapshot":
      return engine.exportSnapshot();
    case "gc":
      return engine.gc();
    case "workflowState":
      return engine.workflowState(String(params.caseId ?? ""), typeof params.maxOrder === "number" ? params.maxOrder : undefined);
    case "workflowNext":
      return engine.workflowNext(String(params.caseId ?? ""), typeof params.limit === "number" ? params.limit : undefined);
    case "workflowRisks":
      return engine.workflowRisks(String(params.caseId ?? ""), typeof params.limit === "number" ? params.limit : undefined);
    case "workflowRecall":
      return engine.workflowRecall(
        String(params.caseId ?? ""),
        typeof params.mode === "string" ? parseRecallMode(params.mode) : undefined,
        typeof params.limit === "number" ? params.limit : undefined
      );
    default:
      throw new Error(`Unsupported RPC method: ${method}`);
  }
}

const program = new Command();

program
  .name("sherpa")
  .description("Sherpa procedural memory CLI")
  .option("--root <dir>", "Sherpa store root", defaultRoot())
  .option("--default-order <n>", "Default suffix order")
  .option("--min-order <n>", "Minimum suffix order")
  .option("--max-order <n>", "Maximum suffix order")
  .option("--min-support <n>", "Minimum support before using a suffix state");

program
  .command("ingest")
  .description("Append an event to the canonical ledger and rebuild the graph")
  .argument("[file]", "JSON event file; reads stdin when omitted")
  .action(async (file, options, command) => {
    const engine = createEngine(command);
    const event = await readEventInput(file);
    printJson(await engine.ingest(event));
  });

program
  .command("ingest-batch")
  .description("Append multiple events to the canonical ledger and rebuild the graph")
  .argument("[file]", "JSON array file; reads stdin when omitted")
  .action(async (file, options, command) => {
    const engine = createEngine(command);
    const events = await readEventBatchInput(file);
    printJson(await engine.ingestBatch(events));
  });

program
  .command("rebuild")
  .description("Rebuild the graph store from the append-only ledger")
  .action(async (options, command) => {
    const engine = createEngine(command);
    await engine.rebuild();
    printJson(await engine.status());
  });

program
  .command("status")
  .description("Show ledger and graph status")
  .action(async (options, command) => {
    const engine = createEngine(command);
    printJson(await engine.status());
  });

program
  .command("workflow-status")
  .description("Show workflow backend status")
  .action(async (options, command) => {
    const engine = createEngine(command);
    printJson(await engine.status());
  });

program
  .command("doctor")
  .description("Run basic health checks")
  .action(async (options, command) => {
    const engine = createEngine(command);
    printJson(await engine.doctor());
  });

program
  .command("export")
  .description("Export a JSON snapshot of the current graph and case state")
  .action(async (options, command) => {
    const engine = createEngine(command);
    printJson(await engine.exportSnapshot());
  });

program
  .command("gc")
  .description("Vacuum the graph and prune tmp/export artifacts")
  .action(async (options, command) => {
    const engine = createEngine(command);
    printJson(await engine.gc());
  });

program
  .command("workflow-state")
  .description("Infer the current workflow state for a case")
  .requiredOption("--case-id <caseId>", "Case identifier")
  .option("--max-order <n>", "Maximum suffix length", "3")
  .action(async (options, command) => {
    const engine = createEngine(command);
    printJson(await engine.workflowState(options.caseId, parseInteger(options.maxOrder, "--max-order")));
  });

program
  .command("workflow-next")
  .description("Suggest likely next workflow events for a case")
  .requiredOption("--case-id <caseId>", "Case identifier")
  .option("--limit <n>", "Maximum number of candidates", "5")
  .action(async (options, command) => {
    const engine = createEngine(command);
    printJson(await engine.workflowNext(options.caseId, parseInteger(options.limit, "--limit")));
  });

program
  .command("workflow-risks")
  .description("Show likely failure or stall branches for a case")
  .requiredOption("--case-id <caseId>", "Case identifier")
  .option("--limit <n>", "Maximum number of risks", "3")
  .action(async (options, command) => {
    const engine = createEngine(command);
    printJson(await engine.workflowRisks(options.caseId, parseInteger(options.limit, "--limit")));
  });

program
  .command("workflow-recall")
  .description("Recall similar prior paths and their continuations")
  .requiredOption("--case-id <caseId>", "Case identifier")
  .option("--mode <mode>", "successful, failed, or any", "successful")
  .option("--limit <n>", "Maximum number of recalled paths", "3")
  .action(async (options, command) => {
    const engine = createEngine(command);
    printJson(await engine.workflowRecall(options.caseId, parseRecallMode(options.mode), parseInteger(options.limit, "--limit")));
  });

program
  .command("serve")
  .description("Run a local Sherpa JSON HTTP daemon")
  .option("--host <host>", "Bind host", "127.0.0.1")
  .option("--port <port>", "Bind port", "8787")
  .action(async (options, command) => {
    const engine = createEngine(command);
    await engine.init();

    const host = options.host;
    const port = parseInteger(options.port, "--port");
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          ok: true,
          backend: "sherpa",
          transport: "http"
        });
        return;
      }

      if (request.method !== "POST" || url.pathname !== "/rpc") {
        writeJson(response, 404, {
          ok: false,
          error: {
            message: "Not found"
          }
        });
        return;
      }

      try {
        const body = await readJsonBody(request);
        if (!body.method) {
          writeJson(response, 400, {
            ok: false,
            error: {
              message: "Missing RPC method"
            }
          });
          return;
        }

        const result = await executeRpc(engine, body.method, body.params);
        writeJson(response, 200, {
          ok: true,
          result
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJson(response, 500, {
          ok: false,
          error: {
            message
          }
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    process.stdout.write(`Sherpa daemon listening on http://${host}:${port}\n`);
  });

program
  .command("validate")
  .description("Run next-step validation against a canonical Sherpa dataset")
  .option("--dataset <file>", "JSON or JSONL validation dataset", path.join(process.cwd(), "fixtures/validation/synthetic-workflows.json"))
  .option("--format <format>", "auto, json, jsonl, csv, or xes", "auto")
  .option("--case-field <name>", "Case identifier field for CSV or XES imports")
  .option("--type-field <name>", "Event type field for CSV or XES imports")
  .option("--timestamp-field <name>", "Timestamp field for CSV or XES imports")
  .option("--outcome-field <name>", "Outcome field for CSV or XES imports")
  .option("--source-field <name>", "Event source field for CSV or XES imports")
  .option("--agent-field <name>", "Agent identifier field for CSV or XES imports")
  .option("--actor-field <name>", "Actor field for CSV or XES imports")
  .option("--csv-delimiter <char>", "CSV delimiter for tabular imports", ",")
  .option("--top-k <n>", "Maximum candidate window for accuracy scoring", "3")
  .option("--max-misses <n>", "Maximum number of miss examples to include in the report", "25")
  .option("--min-top1 <ratio>", "Fail if top1 accuracy drops below this ratio")
  .option("--min-topk <ratio>", "Fail if topK accuracy drops below this ratio")
  .option("--max-miss-count <n>", "Fail if total miss count exceeds this number")
  .action(async (options, command) => {
    const globals = command.optsWithGlobals() as {
      root?: string;
      defaultOrder?: string;
      minOrder?: string;
      maxOrder?: string;
      minSupport?: string;
    };
    const report = await validateDatasetFile(options.dataset, {
      rootParent: globals.root ?? defaultRoot(),
      format: options.format,
      ...(options.caseField ? { caseField: options.caseField } : {}),
      ...(options.typeField ? { typeField: options.typeField } : {}),
      ...(options.timestampField ? { timestampField: options.timestampField } : {}),
      ...(options.outcomeField ? { outcomeField: options.outcomeField } : {}),
      ...(options.sourceField ? { sourceField: options.sourceField } : {}),
      ...(options.agentField ? { agentField: options.agentField } : {}),
      ...(options.actorField ? { actorField: options.actorField } : {}),
      ...(options.csvDelimiter ? { csvDelimiter: options.csvDelimiter } : {}),
      ...(globals.defaultOrder ? { defaultOrder: parseInteger(globals.defaultOrder, "--default-order") } : {}),
      ...(globals.minOrder ? { minOrder: parseInteger(globals.minOrder, "--min-order") } : {}),
      ...(globals.maxOrder ? { maxOrder: parseInteger(globals.maxOrder, "--max-order") } : {}),
      ...(globals.minSupport ? { minSupport: parseInteger(globals.minSupport, "--min-support") } : {}),
      topK: parseInteger(options.topK, "--top-k"),
      maxMisses: parseInteger(options.maxMisses, "--max-misses")
    });
    assertValidationThresholds(report, {
      ...(options.minTop1 ? { minTop1Accuracy: parseRatio(options.minTop1, "--min-top1") } : {}),
      ...(options.minTopk ? { minTopKAccuracy: parseRatio(options.minTopk, "--min-topk") } : {}),
      ...(options.maxMissCount ? { maxMissCount: parseInteger(options.maxMissCount, "--max-miss-count") } : {})
    });
    printJson(report);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
