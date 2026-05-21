#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { input: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      args.input = argv[++index];
    } else if (arg === "--output") {
      args.output = argv[++index];
    } else if (arg === "--help") {
      args.help = true;
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: pnpm harness:statebench:analyze -- --input artifacts/state-bench/local-confidence-run",
    "",
    "Reads summary.json plus trajectories and prints a paired baseline-vs-Sherpa confidence report.",
  ].join("\n");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listTrajectoryFiles(root) {
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "summary.json") {
        files.push(fullPath);
      }
    }
  }
  walk(root);
  return files.sort();
}

function trajectoryKey(root, file) {
  const relative = path.relative(root, file);
  const parts = relative.split(path.sep);
  const [variant, domain, , filename] = parts;
  return { variant, domain, task: filename.replace(/\.json$/, "") };
}

function statusOf(item) {
  if (item.status === "ERR" || item.error) return "ERR";
  return "OK";
}

function scoreOf(item) {
  if (item.state_score !== undefined) return item.state_score;
  if (item.state_requirements_met !== undefined) return item.state_requirements_met;
  return null;
}

function isInfraError(item) {
  const text = String(item.error || "").toLowerCase();
  return text.includes("gateway") || text.includes("temporarily unavailable") || text.includes("connection refused");
}

function compactTask(item) {
  return {
    status: statusOf(item),
    state: scoreOf(item),
    turns: Number(item.turns || 0),
    toolCalls: Number(item.tool_calls || 0),
    toolErrors: Number(item.tool_errors || 0),
    redundantCalls: Number(item.redundant_calls || 0),
    memoryCalls: Number(item.memory_calls || 0),
    infraError: isInfraError(item),
    error: item.error || null,
  };
}

function loadRun(root) {
  const byKey = new Map();
  const summaryPath = path.join(root, "summary.json");
  if (fs.existsSync(summaryPath)) {
    const summary = readJson(summaryPath);
    for (const result of summary.results || []) {
      const key = `${result.domain}/${result.task_id}/${result.variant}`;
      byKey.set(key, compactTask(result));
    }
  }

  for (const file of listTrajectoryFiles(root)) {
    const { variant, domain, task } = trajectoryKey(root, file);
    if (!variant || !domain || !task) continue;
    const key = `${domain}/${task}/${variant}`;
    const trajectory = readJson(file);
    byKey.set(key, { ...compactTask(trajectory), ...byKey.get(key) });
  }
  return byKey;
}

function collectPairs(byKey) {
  const tasks = new Set();
  for (const key of byKey.keys()) {
    const [domain, task] = key.split("/");
    tasks.add(`${domain}/${task}`);
  }
  return [...tasks].sort().map((taskKey) => {
    const [domain, task] = taskKey.split("/");
    return {
      domain,
      task,
      baseline: byKey.get(`${domain}/${task}/baseline`) || null,
      sherpa: byKey.get(`${domain}/${task}/sherpa`) || null,
    };
  });
}

function aggregate(rows) {
  const totals = {
    paired: 0,
    bothOk: 0,
    baselineOk: 0,
    sherpaOk: 0,
    baselineStatePass: 0,
    sherpaStatePass: 0,
    sherpaWins: 0,
    baselineWins: 0,
    ties: 0,
    infraErrors: 0,
    toolCallDelta: 0,
    toolErrorDelta: 0,
    memoryCalls: 0,
  };

  for (const row of rows) {
    if (!row.baseline && !row.sherpa) continue;
    totals.paired += Number(Boolean(row.baseline && row.sherpa));
    if (row.baseline?.infraError || row.sherpa?.infraError) totals.infraErrors += 1;
    if (row.baseline?.status === "OK") totals.baselineOk += 1;
    if (row.sherpa?.status === "OK") totals.sherpaOk += 1;
    if (row.baseline?.state === 1) totals.baselineStatePass += 1;
    if (row.sherpa?.state === 1) totals.sherpaStatePass += 1;

    if (row.baseline && row.sherpa && row.baseline.status === "OK" && row.sherpa.status === "OK") {
      const baselineState = row.baseline.state === 1 ? 1 : 0;
      const sherpaState = row.sherpa.state === 1 ? 1 : 0;
      if (sherpaState > baselineState) totals.sherpaWins += 1;
      else if (baselineState > sherpaState) totals.baselineWins += 1;
      else totals.ties += 1;
      totals.toolCallDelta += row.sherpa.toolCalls - row.baseline.toolCalls;
      totals.toolErrorDelta += row.sherpa.toolErrors - row.baseline.toolErrors;
      totals.memoryCalls += row.sherpa.memoryCalls;
    }
  }

  return totals;
}

function renderMarkdown(root, rows, totals) {
  const lines = [];
  lines.push(`# STATE-Bench Local Confidence Analysis`);
  lines.push("");
  lines.push(`Input: \`${root}\``);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- Paired tasks: ${totals.paired}`);
  lines.push(`- OK runs: baseline ${totals.baselineOk}, Sherpa ${totals.sherpaOk}`);
  lines.push(`- State passes: baseline ${totals.baselineStatePass}, Sherpa ${totals.sherpaStatePass}`);
  lines.push(`- Paired state outcomes: Sherpa wins ${totals.sherpaWins}, baseline wins ${totals.baselineWins}, ties ${totals.ties}`);
  lines.push(`- Paired tool-call delta, Sherpa minus baseline: ${totals.toolCallDelta}`);
  lines.push(`- Paired tool-error delta, Sherpa minus baseline: ${totals.toolErrorDelta}`);
  lines.push(`- Sherpa memory calls in paired OK tasks: ${totals.memoryCalls}`);
  lines.push(`- Runs with infrastructure errors: ${totals.infraErrors}`);
  lines.push("");
  lines.push(`## Paired Tasks`);
  lines.push("");
  lines.push("| Domain | Task | Baseline | Sherpa | Tool delta | Error delta | Memory |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const row of rows) {
    const baseline = row.baseline;
    const sherpa = row.sherpa;
    const baselineLabel = baseline ? `${baseline.status}/${baseline.state ?? "-"}` : "-";
    const sherpaLabel = sherpa ? `${sherpa.status}/${sherpa.state ?? "-"}` : "-";
    const toolDelta = baseline && sherpa ? sherpa.toolCalls - baseline.toolCalls : "";
    const errorDelta = baseline && sherpa ? sherpa.toolErrors - baseline.toolErrors : "";
    const memory = sherpa ? sherpa.memoryCalls : "";
    lines.push(`| ${row.domain} | ${row.task} | ${baselineLabel} | ${sherpaLabel} | ${toolDelta} | ${errorDelta} | ${memory} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.input) {
  console.log(usage());
  process.exit(args.help ? 0 : 1);
}

const root = path.resolve(args.input);
const byKey = loadRun(root);
const rows = collectPairs(byKey);
const totals = aggregate(rows);
const markdown = renderMarkdown(root, rows, totals);
if (args.output) {
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, markdown);
}
process.stdout.write(markdown);
