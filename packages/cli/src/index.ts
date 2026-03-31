import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { SherpaEngine, type SherpaEventInput } from "@sherpa/core";
import { Command, type Command as CommandInstance } from "commander";

function defaultRoot() {
  return path.join(process.cwd(), ".sherpa");
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

async function readEventInput(file?: string): Promise<SherpaEventInput> {
  const input = file ? await fs.readFile(file, "utf8") : await readStdin();
  return JSON.parse(input) as SherpaEventInput;
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

const program = new Command();

program
  .name("sherpa")
  .description("Sherpa procedural memory CLI")
  .option("--root <dir>", "Sherpa store root", defaultRoot());

program
  .command("ingest")
  .description("Append an event to the canonical ledger and rebuild the graph")
  .argument("[file]", "JSON event file; reads stdin when omitted")
  .action(async (file, options, command) => {
    const root = resolveRoot(command);
    const engine = new SherpaEngine({ rootDir: root });
    const event = await readEventInput(file);
    printJson(await engine.ingest(event));
  });

program
  .command("rebuild")
  .description("Rebuild the graph store from the append-only ledger")
  .action(async (options, command) => {
    const root = resolveRoot(command);
    const engine = new SherpaEngine({ rootDir: root });
    await engine.rebuild();
    printJson(await engine.status());
  });

program
  .command("status")
  .description("Show ledger and graph status")
  .action(async (options, command) => {
    const root = resolveRoot(command);
    const engine = new SherpaEngine({ rootDir: root });
    printJson(await engine.status());
  });

program
  .command("doctor")
  .description("Run basic health checks")
  .action(async (options, command) => {
    const root = resolveRoot(command);
    const engine = new SherpaEngine({ rootDir: root });
    printJson(await engine.doctor());
  });

program
  .command("workflow-state")
  .description("Infer the current workflow state for a case")
  .requiredOption("--case-id <caseId>", "Case identifier")
  .option("--max-order <n>", "Maximum suffix length", "3")
  .action(async (options, command) => {
    const root = resolveRoot(command);
    const engine = new SherpaEngine({ rootDir: root });
    printJson(await engine.workflowState(options.caseId, Number(options.maxOrder)));
  });

program
  .command("workflow-next")
  .description("Suggest likely next workflow events for a case")
  .requiredOption("--case-id <caseId>", "Case identifier")
  .option("--limit <n>", "Maximum number of candidates", "5")
  .action(async (options, command) => {
    const root = resolveRoot(command);
    const engine = new SherpaEngine({ rootDir: root });
    printJson(await engine.workflowNext(options.caseId, Number(options.limit)));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
