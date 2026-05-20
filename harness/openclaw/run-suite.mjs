import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = path.join(rootDir, "harness/openclaw/compose.yml");
const hostAuthComposeFile = path.join(rootDir, "harness/openclaw/compose.host-auth.yml");
const defaultSuitePath = path.join(rootDir, "harness/openclaw/tasks/smoke-suite.json");

function parseArgs(argv) {
  const args = {
    suite: defaultSuitePath,
    resultsDir: "",
    mode: process.env.SHERPA_HARNESS_MODE ?? "",
    agentMode: process.env.OPENCLAW_AGENT_MODE ?? "local"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--suite" && next) {
      args.suite = path.resolve(next);
      index += 1;
    } else if (arg === "--results-dir" && next) {
      args.resultsDir = path.resolve(next);
      index += 1;
    } else if (arg === "--mode" && next) {
      args.mode = next;
      index += 1;
    } else if (arg === "--agent-mode" && next) {
      args.agentMode = next;
      index += 1;
    } else if (arg === "--help") {
      process.stdout.write(
        [
          "Usage: node harness/openclaw/run-suite.mjs [options]",
          "",
          "Options:",
          "  --suite <file>        Task suite JSON file",
          "  --results-dir <dir>   Directory for result artifacts",
          "  --mode <mode>         none, shadow, tool-only, or advisory",
          "  --agent-mode <mode>   local or gateway"
        ].join("\n") + "\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function composeArgs() {
  const args = ["compose", "-f", composeFile];
  if (process.env.OPENCLAW_COPY_HOST_AUTH === "1") {
    args.push("-f", hostAuthComposeFile);
  }
  return args;
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: rootDir,
    env: options.env ?? process.env,
    encoding: options.encoding ?? "utf8",
    input: options.input,
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024
  });

  if (options.allowFailure !== true && (result.status !== 0 || result.error)) {
    throw new Error(
      `docker ${args.join(" ")} failed with exit ${result.status}${result.error ? ` (${result.error.message})` : ""}\n${result.stderr ?? ""}${result.stdout ?? ""}`
    );
  }

  return result;
}

function safeName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function writeResult(filePath, result) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        exitCode: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? ""
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function gatewayAuthArgs() {
  const mode = process.env.OPENCLAW_GATEWAY_AUTH_MODE ?? "none";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? "sherpa-harness-token";
  return mode === "none" ? [] : ["--token", token];
}

function parseJsonObjectFromStdout(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) {
    return null;
  }

  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

function workflowStatusCommand(agentIdValue) {
  return [
    "pnpm",
    "exec",
    "openclaw",
    "gateway",
    "call",
    "sherpa.workflow_status",
    ...gatewayAuthArgs(),
    "--params",
    JSON.stringify({ agentId: agentIdValue })
  ];
}

function waitForWorkflowStatusCapture(dockerCompose, env, agentIdValue, previousEvents) {
  const deadline = Date.now() + 90000;
  let lastResult = null;
  let lastPayload = null;

  while (Date.now() < deadline) {
    lastResult = runDocker([...dockerCompose, "exec", "-T", "openclaw", ...workflowStatusCommand(agentIdValue)], {
      env,
      allowFailure: true,
      timeoutMs: 30000
    });
    lastPayload = parseJsonObjectFromStdout(lastResult.stdout ?? "");

    if (
      lastResult.status === 0 &&
      lastPayload &&
      typeof lastPayload.events === "number" &&
      lastPayload.events > previousEvents
    ) {
      return { result: lastResult, payload: lastPayload };
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }

  return { result: lastResult, payload: lastPayload };
}

function approveHarnessDeviceScopes(dockerCompose, env) {
  const script = String.raw`
const fs = require("node:fs");
const path = "/home/openclaw/.openclaw/devices/paired.json";
if (!fs.existsSync(path)) {
  process.exit(0);
}
const scopes = [
  "operator.read",
  "operator.write",
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
  "operator.talk.secrets"
];
const paired = JSON.parse(fs.readFileSync(path, "utf8"));
for (const device of Object.values(paired)) {
  device.role = device.role ?? "operator";
  device.roles = Array.from(new Set([...(device.roles ?? []), "operator"]));
  device.scopes = scopes;
  device.approvedScopes = scopes;
  device.tokens = device.tokens ?? {};
  if (device.tokens.operator) {
    device.tokens.operator.scopes = scopes;
  }
}
fs.writeFileSync(path, JSON.stringify(paired, null, 2) + "\n");
`;
  runDocker([...dockerCompose, "exec", "-T", "openclaw", "node", "-e", script], {
    env,
    timeoutMs: 15000
  });
}

function waitForGatewayHealth(dockerCompose, env) {
  const deadline = Date.now() + 120000;
  let lastResult = null;

  while (Date.now() < deadline) {
    lastResult = runDocker([...dockerCompose, "exec", "-T", "openclaw", "pnpm", "exec", "openclaw", "gateway", "health"], {
      env,
      allowFailure: true,
      timeoutMs: 15000
    });

    if (lastResult.status === 0 && !lastResult.error) {
      return;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }

  throw new Error(
    `OpenClaw gateway did not become healthy within 120s\n${lastResult?.stderr ?? ""}${lastResult?.stdout ?? ""}`
  );
}

const args = parseArgs(process.argv.slice(2));
const suite = readJson(args.suite);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(suite.name ?? "suite")}`;
const resultsDir = args.resultsDir || path.join(rootDir, "artifacts/openclaw-harness", runId);
const mode = args.mode || suite.mode || "advisory";
const agentId = process.env.SHERPA_HARNESS_AGENT_ID ?? suite.agentId ?? "main";
const openclawConfigDir = process.env.OPENCLAW_CONFIG_DIR ?? "/home/openclaw/.openclaw";
const timeoutDefault = Number.parseInt(String(suite.timeoutSeconds ?? 120), 10);
const tasks = Array.isArray(suite.tasks) ? suite.tasks : [];
const dockerCompose = composeArgs();
const composeTimeoutMs = Number.parseInt(process.env.SHERPA_HARNESS_COMPOSE_TIMEOUT_MS ?? "600000", 10);
const suiteEnv = {
  ...process.env,
  SHERPA_HARNESS_MODE: mode,
  SHERPA_HARNESS_AGENT_ID: agentId,
  OPENCLAW_AGENT_MODE: args.agentMode
};

if (tasks.length === 0) {
  throw new Error(`Suite ${args.suite} has no tasks`);
}

fs.rmSync(resultsDir, { recursive: true, force: true });
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(
  path.join(resultsDir, "run-metadata.json"),
  JSON.stringify(
    {
      runId,
      suitePath: args.suite,
      suiteName: suite.name ?? null,
      mode,
      agentMode: args.agentMode,
      agentId,
      model: process.env.OPENCLAW_MODEL_PRIMARY ?? "openai/gpt-5.4",
      copyHostAuth: process.env.OPENCLAW_COPY_HOST_AUTH === "1",
      startedAt: new Date().toISOString()
    },
    null,
    2
  ) + "\n",
  "utf8"
);

runDocker([...dockerCompose, "down", "-v", "--remove-orphans"], {
  env: suiteEnv,
  allowFailure: true,
  timeoutMs: 60000
});
runDocker([...dockerCompose, "up", "-d", "--build", "--force-recreate"], {
  env: suiteEnv,
  timeoutMs: Number.isFinite(composeTimeoutMs) ? composeTimeoutMs : 600000
});
waitForGatewayHealth(dockerCompose, suiteEnv);
approveHarnessDeviceScopes(dockerCompose, suiteEnv);

let failures = 0;
let lastSeenEvents = 0;

for (const [index, task] of tasks.entries()) {
  const taskId = safeName(task.id ?? `task-${index + 1}`);
  const taskDir = path.join(resultsDir, `${String(index + 1).padStart(3, "0")}-${taskId}`);
  const timeoutSeconds = Number.parseInt(String(task.timeoutSeconds ?? timeoutDefault), 10);
  const agentArgs = ["pnpm", "exec", "openclaw", "agent"];

  if (args.agentMode === "local") {
    agentArgs.push("--local");
  }

  agentArgs.push(
    "--agent",
    String(task.agentId ?? agentId),
    "--message",
    String(task.message ?? ""),
    "--json",
    "--timeout",
    String(Number.isFinite(timeoutSeconds) ? timeoutSeconds : 120)
  );

  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2) + "\n", "utf8");

  const taskResult = runDocker([...dockerCompose, "exec", "-T", "openclaw", ...agentArgs], {
    env: suiteEnv,
    allowFailure: true
  });
  writeResult(path.join(taskDir, "agent-result.json"), taskResult);

  const expectedAgentId = String(task.agentId ?? agentId);
  const previousEvents = lastSeenEvents;
  const { result: workflowStatus, payload: workflowStatusPayload } = waitForWorkflowStatusCapture(
    dockerCompose,
    suiteEnv,
    expectedAgentId,
    previousEvents
  );
  writeResult(path.join(taskDir, "workflow-status-gateway.json"), workflowStatus);
  if (workflowStatusPayload && typeof workflowStatusPayload.events === "number") {
    lastSeenEvents = Math.max(lastSeenEvents, workflowStatusPayload.events);
  }

  const cliStatus = runDocker(
    [
      ...dockerCompose,
      "exec",
      "-T",
      "openclaw",
      "node",
      "packages/cli/dist/index.js",
      "--root",
      `${openclawConfigDir}/agents/${task.agentId ?? agentId}/sherpa`,
      "workflow-status"
    ],
    {
      env: suiteEnv,
      allowFailure: true
    }
  );
  writeResult(path.join(taskDir, "workflow-status-cli.json"), cliStatus);

  if (
    taskResult.status !== 0 ||
    workflowStatus.status !== 0 ||
    cliStatus.status !== 0 ||
    !workflowStatusPayload ||
    typeof workflowStatusPayload.events !== "number" ||
    workflowStatusPayload.events <= previousEvents
  ) {
    failures += 1;
  }
}

const archiveResult = runDocker(
  [
    ...dockerCompose,
    "exec",
    "-T",
    "openclaw",
    "tar",
    "-C",
    `${openclawConfigDir}/agents/${agentId}`,
    "-cf",
    "-",
    "."
  ],
  {
    env: suiteEnv,
    encoding: "buffer",
    allowFailure: true
  }
);

if (archiveResult.status === 0 && archiveResult.stdout) {
  fs.writeFileSync(path.join(resultsDir, "agent-state.tar"), archiveResult.stdout);
} else {
  writeResult(path.join(resultsDir, "agent-state-archive-error.json"), archiveResult);
}

fs.writeFileSync(
  path.join(resultsDir, "summary.json"),
  JSON.stringify(
    {
      runId,
      taskCount: tasks.length,
      failures,
      completedAt: new Date().toISOString(),
      resultsDir
    },
    null,
    2
  ) + "\n",
  "utf8"
);

process.stdout.write(`${resultsDir}\n`);
process.exitCode = failures === 0 ? 0 : 1;
