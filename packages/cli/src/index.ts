import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { SherpaEngine, type SherpaEventInput, type WorkflowRecallMode } from "@sherpa/core";
import { Command, type Command as CommandInstance } from "commander";

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

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
