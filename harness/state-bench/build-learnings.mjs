#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "../..");

function usage() {
  return [
    "Usage: node harness/state-bench/build-learnings.mjs --state-bench-dir <dir> [options]",
    "",
    "Options:",
    "  --state-bench-dir <dir>  STATE-Bench checkout containing datasets/train_task_trajectories",
    "  --train-dir <dir>        Override train trajectory directory",
    "  --output <file>          Learning artifact path",
    "  --root <dir>             Sherpa store root for projected train trajectories",
    "  --max-per-domain <n>     Limit trajectories per domain for smoke runs",
    "  --reset                  Delete the target Sherpa store before ingesting",
    "  --help                   Show this message"
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry === "--") {
      continue;
    }
    if (entry === "--help" || entry === "-h") {
      args.help = true;
      continue;
    }
    if (entry === "--reset") {
      args.reset = true;
      continue;
    }
    if (!entry.startsWith("--")) {
      throw new Error(`Unexpected argument: ${entry}`);
    }
    const key = entry.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${entry}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listJsonFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function listTrajectoryFiles(trainDir, maxPerDomain) {
  const domains = (await fs.readdir(trainDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const files = [];
  for (const domain of domains) {
    const domainFiles = await listJsonFiles(path.join(trainDir, domain));
    files.push(
      ...domainFiles.slice(0, maxPerDomain ?? domainFiles.length).map((filePath) => ({
        domain,
        filePath
      }))
    );
  }

  return files;
}

function titleFromTaskId(taskId) {
  return taskId
    .replace(/^\d+-/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compact(value, maxLength = 240) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "around",
  "because",
  "before",
  "being",
  "from",
  "have",
  "help",
  "into",
  "like",
  "need",
  "order",
  "please",
  "that",
  "their",
  "them",
  "then",
  "there",
  "this",
  "want",
  "with",
  "would",
  "your"
]);

function tokenizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_.:-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOPWORDS.has(token) && !/^ord-\d+/i.test(token));
}

function topTerms(values, limit = 10) {
  const counts = new Map();
  for (const value of values) {
    for (const token of tokenizeText(value)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([token]) => token);
}

function formatToolSequence(sequence, limit = 14) {
  if (sequence.length <= limit) {
    return sequence.join(" -> ");
  }
  return `${sequence.slice(0, limit).join(" -> ")} -> ...`;
}

function collectStrings(value, limit = 12, output = []) {
  if (output.length >= limit || value === null || value === undefined) {
    return output;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    if (/^[a-zA-Z0-9_.:-]{2,80}$/.test(text)) {
      output.push(text);
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, limit, output);
      if (output.length >= limit) {
        break;
      }
    }
    return output;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value).sort()) {
      collectStrings(value[key], limit, output);
      if (output.length >= limit) {
        break;
      }
    }
  }

  return output;
}

function eventIntentForTool(name) {
  if (/^(get|list|search|lookup|check|calculate|quote|find|validate)/.test(name)) {
    return "investigate";
  }
  if (/^(cancel|book|create|update|process|issue|apply|add|remove|exchange|refund|return)/.test(name)) {
    return "update";
  }
  return "request";
}

function eventOutcomeFromResult(result) {
  if (result && typeof result === "object" && ("error" in result || "errors" in result)) {
    return "failure";
  }
  return "success";
}

function extractInitialUser(conversation) {
  return conversation.find((message) => message.role === "user")?.content ?? "";
}

function extractFinalAssistant(conversation) {
  const assistants = conversation.filter((message) => message.role === "assistant" && message.content);
  return assistants.at(-1)?.content ?? "";
}

function extractToolCalls(conversation) {
  return conversation.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      return [];
    }
    return message.tool_calls.filter((call) => call && typeof call.name === "string");
  });
}

function buildEvents({ domain, taskId, trajectory }) {
  const conversation = Array.isArray(trajectory.conversation) ? trajectory.conversation : [];
  const labels = ["state-bench", `domain:${domain}`, `task:${taskId}`];
  const taskClass = "general-task";
  const baseTime = Date.parse("2026-01-01T00:00:00.000Z");
  const events = [];
  let offset = 0;

  const pushEvent = (input) => {
    events.push({
      caseId: `state-bench:${domain}:${taskId}`,
      ts: new Date(baseTime + offset * 1000).toISOString(),
      source: input.source,
      type: input.type,
      actor: input.actor,
      outcome: input.outcome ?? "unknown",
      labels,
      entities: input.entities ?? [],
      projection: {
        version: "draft-v1",
        source: "manual",
        taskClass,
        intent: input.intent,
        operation: input.operation,
        artifactClass: "tooling",
        entityRoles: input.entityRoles ?? [`domain:${domain}`],
        confidence: 0.9
      },
      meta: input.meta ?? {}
    });
    offset += 1;
  };

  const initialUser = extractInitialUser(conversation);
  pushEvent({
    source: "state-bench.user",
    type: "task.requested",
    actor: "user",
    intent: "request",
    operation: "message-received",
    entities: collectStrings(initialUser, 8),
    meta: { text: compact(initialUser, 500) }
  });

  for (const call of extractToolCalls(conversation)) {
    const argumentEntities = collectStrings(call.arguments, 8);
    const resultEntities = collectStrings(call.result, 4);
    pushEvent({
      source: "state-bench.tool",
      type: `tool.${call.name}`,
      actor: "agent",
      outcome: eventOutcomeFromResult(call.result),
      intent: eventIntentForTool(call.name),
      operation: "tool-run",
      entities: [...new Set([call.name, ...argumentEntities, ...resultEntities])].slice(0, 16),
      entityRoles: [`domain:${domain}`, `tool:${call.name}`],
      meta: {
        toolName: call.name,
        arguments: call.arguments ?? {},
        resultPreview: compact(JSON.stringify(call.result ?? null), 500)
      }
    });
  }

  pushEvent({
    source: "state-bench.agent",
    type: "task.completed",
    actor: "agent",
    outcome: "success",
    intent: "complete",
    operation: "task-completed",
    entities: [],
    meta: { text: compact(extractFinalAssistant(conversation), 500) }
  });

  return events;
}

function buildLearning({ domain, taskId, trajectory, events }) {
  const conversation = Array.isArray(trajectory.conversation) ? trajectory.conversation : [];
  const toolCalls = extractToolCalls(conversation);
  const toolSequence = toolCalls.map((call) => call.name);
  const initialUser = extractInitialUser(conversation);
  const finalAssistant = extractFinalAssistant(conversation);
  const title = titleFromTaskId(taskId);
  const uniqueTools = [...new Set(toolSequence)];
  const evidenceSequence = toolSequence.length > 0 ? toolSequence.join(" -> ") : "no tools";
  const keyArguments = toolCalls
    .slice(0, 8)
    .map((call) => `${call.name}(${collectStrings(call.arguments, 4).join(", ")})`)
    .join("; ");

  const learning = [
    `When a ${domain} task resembles "${compact(initialUser, 220)}", use the prior successful procedure from ${taskId}.`,
    `Tool order: ${evidenceSequence}.`,
    keyArguments ? `Key arguments observed: ${keyArguments}.` : "",
    finalAssistant ? `Resolution pattern: ${compact(finalAssistant, 260)}` : "",
    "Use this as procedural guidance only; verify current task state, policy, eligibility, and user consent before mutating state."
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: `state-bench:${domain}:${taskId}`,
    kind: "trajectory",
    support: 1,
    domain,
    taskId,
    title,
    queryText: compact(initialUser, 500),
    toolSequence,
    toolSequenceText: evidenceSequence,
    uniqueTools,
    eventTypes: events.map((event) => event.type),
    learning,
    evidence: {
      source: "STATE-Bench train_task_trajectories",
      finalAssistant: compact(finalAssistant, 500),
      eventCount: events.length
    }
  };
}

function buildAggregateLearnings(learnings) {
  const aggregate = [];
  const byDomain = new Map();
  const byDomainAndSequence = new Map();

  for (const learning of learnings) {
    const domainGroup = byDomain.get(learning.domain) ?? [];
    domainGroup.push(learning);
    byDomain.set(learning.domain, domainGroup);

    if (learning.toolSequence.length > 0) {
      const sequenceKey = `${learning.domain}\u001f${learning.toolSequence.join("\u001f")}`;
      const sequenceGroup = byDomainAndSequence.get(sequenceKey) ?? [];
      sequenceGroup.push(learning);
      byDomainAndSequence.set(sequenceKey, sequenceGroup);
    }
  }

  for (const [domain, domainLearnings] of byDomain.entries()) {
    const toolCounts = new Map();
    const transitionCounts = new Map();
    for (const learning of domainLearnings) {
      for (const tool of learning.toolSequence) {
        toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      }
      for (let index = 0; index < learning.toolSequence.length - 1; index += 1) {
        const key = `${learning.toolSequence[index]} -> ${learning.toolSequence[index + 1]}`;
        transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1);
      }
    }

    const commonTools = [...toolCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12)
      .map(([tool, count]) => `${tool} (${count})`);
    const commonTransitions = [...transitionCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([transition, count]) => `${transition} (${count})`);
    const terms = topTerms(domainLearnings.map((learning) => `${learning.title} ${learning.queryText}`), 18);

    aggregate.push({
      id: `state-bench:${domain}:domain-playbook`,
      kind: "domain-playbook",
      support: domainLearnings.length,
      domain,
      taskId: null,
      title: `${domain} procedural playbook`,
      queryText: terms.join(" "),
      toolSequence: [],
      toolSequenceText: commonTransitions.join("; "),
      uniqueTools: commonTools.map((entry) => entry.replace(/ \(\d+\)$/, "")),
      eventTypes: [],
      learning: [
        `For STATE-Bench ${domain} tasks, use memory as a procedural prior after reading the user's request and before mutating state.`,
        commonTools.length > 0 ? `Common successful tools: ${commonTools.join(", ")}.` : "",
        commonTransitions.length > 0 ? `Common successful transitions: ${commonTransitions.join("; ")}.` : "",
        terms.length > 0 ? `Frequent task cues: ${terms.join(", ")}.` : "",
        "Always verify the current user, current state, eligibility, policy constraints, and tool results before taking irreversible actions."
      ]
        .filter(Boolean)
        .join(" "),
      evidence: {
        source: "STATE-Bench train_task_trajectories aggregate",
        support: domainLearnings.length
      }
    });
  }

  const sequenceGroups = [...byDomainAndSequence.values()]
    .filter((group) => group.length >= 2)
    .sort((left, right) => right.length - left.length || left[0].id.localeCompare(right[0].id))
    .slice(0, 120);

  for (const group of sequenceGroups) {
    const first = group[0];
    const terms = topTerms(group.map((learning) => `${learning.title} ${learning.queryText}`), 12);
    const examples = group
      .slice(0, 5)
      .map((learning) => learning.taskId)
      .join(", ");
    aggregate.push({
      id: `state-bench:${first.domain}:sequence:${first.toolSequence.join(">")}`,
      kind: "sequence-recipe",
      support: group.length,
      domain: first.domain,
      taskId: null,
      title: `${first.domain} sequence recipe`,
      queryText: `${terms.join(" ")} ${examples}`,
      toolSequence: first.toolSequence,
      toolSequenceText: formatToolSequence(first.toolSequence),
      uniqueTools: [...new Set(first.toolSequence)],
      eventTypes: [],
      learning: [
        `For ${first.domain} tasks with cues like ${terms.join(", ") || "the retrieved examples"}, ${group.length} successful train trajectories used this tool order: ${formatToolSequence(first.toolSequence)}.`,
        examples ? `Example train tasks: ${examples}.` : "",
        "Use the order as a default procedure, but skip, repeat, or branch when current tool results contradict the example path."
      ]
        .filter(Boolean)
        .join(" "),
      evidence: {
        source: "STATE-Bench train_task_trajectories aggregate",
        support: group.length,
        examples: group.slice(0, 10).map((learning) => learning.taskId)
      }
    });
  }

  return aggregate;
}

async function loadSherpaEngine() {
  const distPath = path.join(rootDir, "packages/core/dist/index.js");
  if (!(await pathExists(distPath))) {
    throw new Error("Missing packages/core/dist/index.js. Run `pnpm build` before building STATE-Bench learnings.");
  }
  const mod = await import(pathToFileURL(distPath).href);
  return mod.SherpaEngine;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const stateBenchDir = args["state-bench-dir"] ? path.resolve(args["state-bench-dir"]) : null;
  const trainDir = args["train-dir"]
    ? path.resolve(args["train-dir"])
    : stateBenchDir
      ? path.join(stateBenchDir, "datasets/train_task_trajectories")
      : null;
  if (!trainDir) {
    throw new Error("--state-bench-dir or --train-dir is required");
  }
  if (!(await pathExists(trainDir))) {
    throw new Error(`Train trajectory directory not found: ${trainDir}`);
  }

  const outputPath = path.resolve(args.output ?? path.join(rootDir, "artifacts/state-bench/sherpa-learnings.json"));
  const sherpaRoot = path.resolve(args.root ?? path.join(rootDir, "artifacts/state-bench/sherpa-store"));
  const maxPerDomain = args["max-per-domain"] ? Number.parseInt(args["max-per-domain"], 10) : undefined;
  if (maxPerDomain !== undefined && (!Number.isInteger(maxPerDomain) || maxPerDomain < 1)) {
    throw new Error("--max-per-domain must be a positive integer");
  }

  if (args.reset) {
    await fs.rm(sherpaRoot, { recursive: true, force: true });
  }

  const SherpaEngine = await loadSherpaEngine();
  const engine = new SherpaEngine({
    rootDir: sherpaRoot,
    stateStrategy: "family-procedure",
    requireProjection: true,
    allowRawFallback: true,
    maxOrder: 5
  });

  const trajectoryFiles = await listTrajectoryFiles(trainDir, maxPerDomain);
  const trajectoryLearnings = [];
  const allEvents = [];

  for (const { domain, filePath } of trajectoryFiles) {
    const taskId = path.basename(filePath, ".json");
    const trajectory = JSON.parse(await fs.readFile(filePath, "utf8"));
    const events = buildEvents({ domain, taskId, trajectory });
    allEvents.push(...events);
    trajectoryLearnings.push(buildLearning({ domain, taskId, trajectory, events }));
  }

  const aggregateLearnings = buildAggregateLearnings(trajectoryLearnings);
  const learnings = [...aggregateLearnings, ...trajectoryLearnings];

  if (allEvents.length > 0) {
    await engine.ingestBatch(allEvents);
  } else {
    await engine.init();
  }

  const status = await engine.status();
  const domains = {};
  for (const learning of trajectoryLearnings) {
    domains[learning.domain] = (domains[learning.domain] ?? 0) + 1;
  }

  const payload = {
    schemaVersion: 1,
    benchmark: "STATE-Bench",
    generatedAt: new Date().toISOString(),
    source: {
      stateBenchDir,
      trainDir
    },
    sherpa: {
      root: sherpaRoot,
      status
    },
    counts: {
      learnings: learnings.length,
      aggregateLearnings: aggregateLearnings.length,
      trajectoryLearnings: trajectoryLearnings.length,
      events: allEvents.length,
      domains
    },
    learnings
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        sherpaRoot,
        learnings: learnings.length,
        events: allEvents.length,
        domains,
        graphStates: status.states
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
