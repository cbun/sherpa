import fs from "node:fs/promises";
import path from "node:path";

import type { Signal } from "@sherpa/core";

import type { ResolvedSherpaPluginConfig } from "./config.js";

export interface ConversationTurn {
  role: string;
  content: string;
}

interface InterpreterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: "openai" | "anthropic";
}

interface OpenClawProviderEntry {
  apiKey?: string;
}

interface OpenClawJsonConfig {
  providers?: Record<string, OpenClawProviderEntry>;
}

function trimToChars(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function summarizeResponses(signal: Signal) {
  const entries = Object.entries(signal.userResponseDist).sort((left, right) => right[1] - left[1]);
  return entries.slice(0, 3).map(([kind, count]) => `${kind}:${count}`).join(", ");
}

export function buildFallbackAdvisory(params: {
  config: ResolvedSherpaPluginConfig;
  signals: Signal[];
}) {
  const [signal] = params.signals;
  if (!signal) {
    return null;
  }

  const basis = signal.basis[0];
  const lines = [
    "Sherpa advisory",
    `Likely next: ${signal.prediction} (${Math.round(signal.probability * 100)}%, support ${signal.support})`
  ];

  const responses = summarizeResponses(signal);
  if (responses) {
    lines.push(`Observed user responses: ${responses}`);
  }

  if (basis?.context) {
    lines.push(`Related case: ${basis.caseId}`);
    lines.push(`Historical context: ${basis.context}`);
  }

  return trimToChars(lines.join("\n"), params.config.advisory.maxChars);
}

async function tryReadOpenClawConfig(): Promise<OpenClawJsonConfig | null> {
  const candidates = [
    process.env.OPENCLAW_CONFIG,
    path.join(process.env.HOME ?? "~", ".openclaw", "openclaw.json"),
    "openclaw.json"
  ].filter(Boolean) as string[];

  for (const configPath of candidates) {
    try {
      const content = await fs.readFile(configPath, "utf8");
      return JSON.parse(content) as OpenClawJsonConfig;
    } catch {
      // ignore
    }
  }

  return null;
}

async function resolveInterpreterConfig(modelOverride?: string): Promise<InterpreterConfig | null> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      apiKey: openaiKey,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: modelOverride ?? "gpt-4o-mini",
      provider: "openai"
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      apiKey: anthropicKey,
      baseUrl: "https://api.anthropic.com/v1",
      model: modelOverride ?? "claude-haiku-3-5",
      provider: "anthropic"
    };
  }

  const openclawConfig = await tryReadOpenClawConfig();
  const openaiProviderKey = openclawConfig?.providers?.openai?.apiKey;
  if (openaiProviderKey) {
    return {
      apiKey: openaiProviderKey,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: modelOverride ?? "gpt-4o-mini",
      provider: "openai"
    };
  }

  const anthropicProviderKey = openclawConfig?.providers?.anthropic?.apiKey;
  if (anthropicProviderKey) {
    return {
      apiKey: anthropicProviderKey,
      baseUrl: "https://api.anthropic.com/v1",
      model: modelOverride ?? "claude-haiku-3-5",
      provider: "anthropic"
    };
  }

  return null;
}

function buildInterpreterPrompt(signals: Signal[], conversation: ConversationTurn[]) {
  return [
    "Given these behavioral signals about the user and the current conversation, decide if anything is worth surfacing.",
    "If so, frame it naturally as a short advisory. If not, return null.",
    "Do not restate raw JSON. Do not mention probabilities unless they materially help.",
    JSON.stringify({ signals, conversation }, null, 2)
  ].join("\n\n");
}

async function callOpenAiInterpreter(
  config: InterpreterConfig,
  signals: Signal[],
  conversation: ConversationTurn[],
  fetchImpl: typeof fetch
) {
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "You decide whether behavioral workflow signals should be surfaced to an AI agent. Return JSON only."
        },
        {
          role: "user",
          content: `${buildInterpreterPrompt(signals, conversation)}\n\nReturn JSON: {\"advisory\": string | null}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    })
  });

  if (!response.ok) {
    throw new Error(`Interpreter API error ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Interpreter returned empty content");
  }

  return JSON.parse(content) as { advisory: string | null };
}

async function callAnthropicInterpreter(
  config: InterpreterConfig,
  signals: Signal[],
  conversation: ConversationTurn[],
  fetchImpl: typeof fetch
) {
  const response = await fetchImpl(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      system: "You decide whether behavioral workflow signals should be surfaced to an AI agent. Return JSON only.",
      messages: [
        {
          role: "user",
          content: `${buildInterpreterPrompt(signals, conversation)}\n\nReturn JSON: {\"advisory\": string | null}`
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Interpreter API error ${response.status}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((entry) => entry.type === "text")?.text;
  const match = text?.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Interpreter returned no JSON");
  }

  return JSON.parse(match[0]) as { advisory: string | null };
}

export async function interpretAdvisory(
  params: {
    config: ResolvedSherpaPluginConfig;
    signals: Signal[];
    conversation: ConversationTurn[];
  },
  dependencies: {
    fetchImpl?: typeof fetch;
    resolveConfig?: (modelOverride?: string) => Promise<InterpreterConfig | null>;
  } = {}
) {
  if (params.signals.length === 0) {
    return null;
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfig ?? resolveInterpreterConfig;
  const interpreterConfig = await resolveConfigImpl(params.config.advisory.interpreterModel);

  if (!interpreterConfig) {
    return buildFallbackAdvisory(params);
  }

  try {
    const result =
      interpreterConfig.provider === "anthropic"
        ? await callAnthropicInterpreter(interpreterConfig, params.signals, params.conversation, fetchImpl)
        : await callOpenAiInterpreter(interpreterConfig, params.signals, params.conversation, fetchImpl);

    return result.advisory ? trimToChars(result.advisory, params.config.advisory.maxChars) : null;
  } catch {
    return buildFallbackAdvisory(params);
  }
}
