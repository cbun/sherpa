import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ConsolidationBatch, EventEnrichment } from "@sherpa/core";
import { CONSOLIDATION_SYSTEM_PROMPT } from "@sherpa/core";

// ---------------------------------------------------------------------------
// LLM classification via Claude CLI (uses Claude Max subscription tokens)
// Pipes prompts via stdin + temp file to avoid arg length limits.
// Falls back to Codex CLI if claude is not available.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

export interface LlmConfig {
  model?: string;
  cli?: "claude" | "codex";
}

async function whichCli(): Promise<"claude" | "codex"> {
  try {
    await execFileAsync("which", ["claude"]);
    return "claude";
  } catch {
    try {
      await execFileAsync("which", ["codex"]);
      return "codex";
    } catch {
      throw new Error(
        "Neither 'claude' nor 'codex' CLI found on PATH. Install Claude Code or Codex CLI."
      );
    }
  }
}

function runCli(
  cli: string,
  args: string[],
  stdin: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cli, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));

    proc.on("error", reject);
    proc.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8");
        reject(new Error(`${cli} exited ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout);
      }
    });

    // Write user prompt to stdin, then close
    proc.stdin.write(stdin);
    proc.stdin.end();

    // Timeout after 3 minutes
    setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`${cli} timed out after 180s`));
    }, 180_000);
  });
}

async function callClaude(
  batch: ConsolidationBatch,
  config: LlmConfig
): Promise<EventEnrichment[]> {
  const cli = config.cli ?? (await whichCli());
  const userPrompt = `Classify these events:\n\n${JSON.stringify(batch, null, 2)}`;

  const args: string[] = [
    "--print",
    "--output-format", "text",
    "--system-prompt", CONSOLIDATION_SYSTEM_PROMPT,
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  // Pipe user prompt via stdin — avoids shell arg length limits
  args.push("-");

  if (process.env.SHERPA_DEBUG) {
    console.error(`[sherpa] calling ${cli} --print (batch of ${batch.events.length})`);
  }

  const stdout = await runCli(cli, args, userPrompt);

  if (!stdout?.trim()) {
    throw new Error(`Empty ${cli} CLI response`);
  }

  // Strip markdown code fences if present
  const cleaned = stdout.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in ${cli} response: ${stdout.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as { enrichments: EventEnrichment[] };
  return parsed.enrichments;
}

export async function createClassifier(overrides?: Partial<LlmConfig>) {
  const cli = overrides?.cli ?? (await whichCli());
  const model = overrides?.model ?? process.env.SHERPA_CONSOLIDATION_MODEL;

  return {
    classify: (batch: ConsolidationBatch) =>
      callClaude(batch, { cli, model }),
    model: model ?? `${cli}-default`
  };
}
