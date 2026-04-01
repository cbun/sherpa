import type { ConsolidationBatch, EventEnrichment } from "@sherpa/core";
import { CONSOLIDATION_SYSTEM_PROMPT } from "@sherpa/core";

// ---------------------------------------------------------------------------
// LLM classification via OpenAI-compatible API
// ---------------------------------------------------------------------------

export interface LlmConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

function resolveConfig(): LlmConfig {
  // Try OpenAI first, then Anthropic
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      apiKey: openaiKey,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: process.env.SHERPA_CONSOLIDATION_MODEL ?? "gpt-4o-mini"
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      apiKey: anthropicKey,
      baseUrl: "https://api.anthropic.com/v1",
      model: process.env.SHERPA_CONSOLIDATION_MODEL ?? "claude-haiku-3-5"
    };
  }

  throw new Error(
    "No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable."
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

export function createClassifier(overrides?: Partial<LlmConfig>) {
  const config = { ...resolveConfig(), ...overrides };
  const isAnthropic = config.baseUrl?.includes("anthropic.com");

  return {
    classify: (batch: ConsolidationBatch) =>
      isAnthropic ? callAnthropic(config, batch) : callOpenAI(config, batch),
    model: config.model ?? "unknown"
  };
}
