import fs from "node:fs/promises";
import path from "node:path";

import type { ConsolidationBatch, EventEnrichment } from "@sherpa/core";
import { CONSOLIDATION_SYSTEM_PROMPT } from "@sherpa/core";

// ---------------------------------------------------------------------------
// LLM classification via OpenAI-compatible API
// Auto-detects from: explicit overrides → OpenClaw config → env vars
// ---------------------------------------------------------------------------

export interface LlmConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

interface OpenClawProviderEntry {
  apiKey?: string;
}

interface OpenClawJsonConfig {
  providers?: Record<string, OpenClawProviderEntry>;
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

function keyFromOpenClawConfig(
  config: OpenClawJsonConfig | null,
  provider: string
): string | undefined {
  if (!config?.providers) return undefined;
  // Try exact match, then common aliases
  const entry = config.providers[provider];
  return entry?.apiKey;
}

async function resolveConfig(): Promise<LlmConfig> {
  const ocConfig = await tryReadOpenClawConfig();

  // Priority: env vars → OpenClaw config (cheap models first)
  const providers: Array<{ provider: string; envKey: string; baseUrl: string; defaultModel: string }> = [
    { provider: "anthropic", envKey: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-haiku-3-5" },
    { provider: "openai", envKey: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" }
  ];

  for (const p of providers) {
    // Check env first
    const envVal = process.env[p.envKey];
    if (envVal) {
      return {
        apiKey: envVal,
        baseUrl: p.provider === "openai" ? (process.env.OPENAI_BASE_URL ?? p.baseUrl) : p.baseUrl,
        model: process.env.SHERPA_CONSOLIDATION_MODEL ?? p.defaultModel
      };
    }

    // Check OpenClaw config
    const ocKey = keyFromOpenClawConfig(ocConfig, p.provider);
    if (ocKey) {
      return {
        apiKey: ocKey,
        baseUrl: p.baseUrl,
        model: process.env.SHERPA_CONSOLIDATION_MODEL ?? p.defaultModel
      };
    }
  }

  throw new Error(
    "No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or configure a provider in openclaw.json."
  );
}

async function callOpenAI(
  config: LlmConfig,
  batch: ConsolidationBatch
): Promise<EventEnrichment[]> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Classify these events:\n\n${JSON.stringify(batch, null, 2)}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Empty LLM response");
  }

  const parsed = JSON.parse(content) as { enrichments: EventEnrichment[] };
  return parsed.enrichments;
}

async function callAnthropic(
  config: LlmConfig,
  batch: ConsolidationBatch
): Promise<EventEnrichment[]> {
  const response = await fetch(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system: CONSOLIDATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Classify these events:\n\n${JSON.stringify(batch, null, 2)}`
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const textBlock = data.content.find((c) => c.type === "text");
  if (!textBlock) {
    throw new Error("Empty Anthropic response");
  }

  // Extract JSON from response (may have markdown wrapping)
  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in Anthropic response");
  }

  const parsed = JSON.parse(jsonMatch[0]) as { enrichments: EventEnrichment[] };
  return parsed.enrichments;
}

export async function createClassifier(overrides?: Partial<LlmConfig>) {
  const resolved = await resolveConfig();
  const config = { ...resolved, ...overrides };
  const isAnthropic = config.baseUrl?.includes("anthropic.com");

  return {
    classify: (batch: ConsolidationBatch) =>
      isAnthropic ? callAnthropic(config, batch) : callOpenAI(config, batch),
    model: config.model ?? "unknown"
  };
}
