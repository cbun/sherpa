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

  // 2. Respect OpenClaw agent defaults — use the configured provider, pick its cheap model
  if (agentDefaults) {
    const defaultProvider = extractProvider(agentDefaults.model) ?? agentDefaults.provider;
    if (defaultProvider) {
      const key = await resolveKey(modelAuth, defaultProvider, config);
      if (key) {
        return {
          apiKey: key,
          baseUrl: baseUrlForProvider(defaultProvider),
          model: cheapModelForProvider(defaultProvider),
          provider: defaultProvider
        };
      }
    }
  }

  // 3. Probe available providers (for setups without explicit defaults)
  const providers = ["anthropic", "openai", "google"];
  for (const provider of providers) {
    const key = await resolveKey(modelAuth, provider, config);
    if (key) {
      return {
        apiKey: key,
        baseUrl: baseUrlForProvider(provider),
        model: cheapModelForProvider(provider),
        provider
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

/** Extract provider prefix from a "provider/model" string */
function extractProvider(model: string): string | null {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : null;
}

/** Pick the cheapest classification-grade model for a provider */
function cheapModelForProvider(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "claude-haiku-3-5";
    case "openai":
      return "gpt-4o-mini";
    case "google":
      return "gemini-2.0-flash";
    default:
      return "gpt-4o-mini"; // safe fallback for OpenAI-compatible
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
