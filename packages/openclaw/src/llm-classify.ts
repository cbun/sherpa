import type { ConsolidationBatch, EventEnrichment } from "@sherpa/core";
import { CONSOLIDATION_SYSTEM_PROMPT } from "@sherpa/core";

// ---------------------------------------------------------------------------
// OpenClaw-native LLM classifier for sleep-cycle consolidation
//
// Uses api.runtime.modelAuth to resolve API keys from OpenClaw's config,
// falling back to env vars. Supports OpenAI-compatible and Anthropic APIs.
// ---------------------------------------------------------------------------

export interface OpenClawLlmConfig {
  /** Resolved API key */
  apiKey: string;
  /** API base URL */
  baseUrl: string;
  /** Model identifier */
  model: string;
  /** Provider name */
  provider: string;
}

export interface ModelAuthRuntime {
  resolveApiKeyForProvider(opts: {
    provider: string;
    cfg: unknown;
  }): Promise<{ apiKey?: string } | null>;
}

export interface AgentDefaults {
  model: string;
  provider: string;
}

/**
 * Resolve LLM config from OpenClaw's runtime, falling back to env vars.
 */
export async function resolveOpenClawLlmConfig(opts: {
  modelAuth?: ModelAuthRuntime | undefined;
  agentDefaults?: AgentDefaults | undefined;
  config?: unknown;
  preferredModel?: string | undefined;
  preferredProvider?: string | undefined;
}): Promise<OpenClawLlmConfig> {
  const { modelAuth, agentDefaults, config, preferredModel, preferredProvider } = opts;

  // 1. Try explicit overrides first
  if (preferredProvider && preferredModel) {
    const key = await resolveKey(modelAuth, preferredProvider, config);
    if (key) {
      return {
        apiKey: key,
        baseUrl: baseUrlForProvider(preferredProvider),
        model: preferredModel,
        provider: preferredProvider
      };
    }
  }

  // 2. Try cheap models for classification (Haiku/Mini class)
  const cheapModels: Array<{ provider: string; model: string }> = [
    { provider: "anthropic", model: "claude-haiku-3-5" },
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "google", model: "gemini-2.0-flash" }
  ];

  for (const candidate of cheapModels) {
    const key = await resolveKey(modelAuth, candidate.provider, config);
    if (key) {
      return {
        apiKey: key,
        baseUrl: baseUrlForProvider(candidate.provider),
        model: candidate.model,
        provider: candidate.provider
      };
    }
  }

  // 3. Fall back to agent defaults
  if (agentDefaults) {
    const key = await resolveKey(modelAuth, agentDefaults.provider, config);
    if (key) {
      return {
        apiKey: key,
        baseUrl: baseUrlForProvider(agentDefaults.provider),
        model: agentDefaults.model,
        provider: agentDefaults.provider
      };
    }
  }

  // 4. Fall back to env vars
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      apiKey: openaiKey,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      provider: "openai"
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      apiKey: anthropicKey,
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-haiku-3-5",
      provider: "anthropic"
    };
  }

  throw new Error(
    "No LLM provider available for consolidation. Configure a provider in OpenClaw or set OPENAI_API_KEY / ANTHROPIC_API_KEY."
  );
}

async function resolveKey(
  modelAuth: ModelAuthRuntime | undefined,
  provider: string,
  config: unknown
): Promise<string | null> {
  if (!modelAuth) return null;
  try {
    const result = await modelAuth.resolveApiKeyForProvider({ provider, cfg: config });
    return result?.apiKey ?? null;
  } catch {
    return null;
  }
}

function baseUrlForProvider(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "openai":
    default:
      return "https://api.openai.com/v1";
  }
}

/**
 * Create a classify function using resolved OpenClaw config.
 */
export function createOpenClawClassifier(llmConfig: OpenClawLlmConfig) {
  const isAnthropic = llmConfig.provider === "anthropic";

  return async (batch: ConsolidationBatch): Promise<EventEnrichment[]> => {
    if (isAnthropic) {
      return callAnthropic(llmConfig, batch);
    }
    return callOpenAI(llmConfig, batch);
  };
}

async function callOpenAI(
  config: OpenClawLlmConfig,
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
        { role: "user", content: `Classify these events:\n\n${JSON.stringify(batch, null, 2)}` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("Empty OpenAI response");

  return (JSON.parse(content) as { enrichments: EventEnrichment[] }).enrichments;
}

async function callAnthropic(
  config: OpenClawLlmConfig,
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
        { role: "user", content: `Classify these events:\n\n${JSON.stringify(batch, null, 2)}` }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
  const textBlock = data.content.find((c) => c.type === "text");
  if (!textBlock) throw new Error("Empty Anthropic response");

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Anthropic response");

  return (JSON.parse(jsonMatch[0]) as { enrichments: EventEnrichment[] }).enrichments;
}
