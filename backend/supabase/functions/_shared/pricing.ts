// Per-model price calculator (USD per 1M tokens).
//
// Public list-prices used here. Caches are billed at significant discounts:
//   - Anthropic: input_tokens_cached at 10% of base input price (90% discount).
//                cache_creation_tokens at 125% of base input price.
//   - OpenAI: cached input at ~50% of base input price.
//   - Gemini, Groq: no cache discount today; treat cached_input == input.
//
// Prices in USD per 1,000,000 tokens. Update when providers change pricing.
// Missing entries fall back to a conservative average so cost is non-zero.

export interface PricePoint {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
  cacheCreationPerM?: number;
}

const PRICES: Record<string, PricePoint> = {
  // Anthropic
  "claude-sonnet-4-5":           { inputPerM: 3.00, outputPerM: 15.00, cachedInputPerM: 0.30, cacheCreationPerM: 3.75 },
  "claude-haiku-4-5":            { inputPerM: 1.00, outputPerM:  5.00, cachedInputPerM: 0.10, cacheCreationPerM: 1.25 },
  "claude-3-5-haiku-latest":     { inputPerM: 0.80, outputPerM:  4.00, cachedInputPerM: 0.08, cacheCreationPerM: 1.00 },
  "claude-3-5-sonnet-latest":    { inputPerM: 3.00, outputPerM: 15.00, cachedInputPerM: 0.30, cacheCreationPerM: 3.75 },

  // OpenAI
  "gpt-4.1":                     { inputPerM: 2.00, outputPerM:  8.00, cachedInputPerM: 0.50 },
  "gpt-4o":                      { inputPerM: 2.50, outputPerM: 10.00, cachedInputPerM: 1.25 },
  "gpt-4o-mini":                 { inputPerM: 0.15, outputPerM:  0.60, cachedInputPerM: 0.075 },

  // Gemini (no cache discount)
  "gemini-2.0-flash":            { inputPerM: 0.10, outputPerM: 0.40 },
  "gemini-2.0-flash-lite":       { inputPerM: 0.075, outputPerM: 0.30 },
  "gemini-1.5-flash":            { inputPerM: 0.075, outputPerM: 0.30 },
  "gemini-1.5-pro":              { inputPerM: 1.25, outputPerM: 5.00 },

  // Groq (no cache discount, Llama family)
  "llama-3.3-70b-versatile":     { inputPerM: 0.59, outputPerM: 0.79 },
};

const FALLBACK: PricePoint = { inputPerM: 1.00, outputPerM: 4.00 };

export interface UsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * Compute USD cost for a single LLM call.
 * Returns 0 if no token data is available (rather than a misleading fallback).
 */
export function computeCostUSD(model: string | undefined, usage: UsageTokens): number {
  if (!usage.inputTokens && !usage.outputTokens && !usage.cachedInputTokens && !usage.cacheCreationTokens) {
    return 0;
  }
  const key = (model || "").toLowerCase().replace(/^models\//, "");
  // Find the closest match — try exact key, then prefix family.
  const point =
    PRICES[key] ||
    Object.entries(PRICES).find(([k]) => key.startsWith(k.split("-").slice(0, 2).join("-")))?.[1] ||
    FALLBACK;

  const baseInput = (usage.inputTokens ?? 0) / 1_000_000 * point.inputPerM;
  const cachedInput = (usage.cachedInputTokens ?? 0) / 1_000_000 *
    (point.cachedInputPerM ?? point.inputPerM);
  const cacheCreate = (usage.cacheCreationTokens ?? 0) / 1_000_000 *
    (point.cacheCreationPerM ?? point.inputPerM);
  const output = (usage.outputTokens ?? 0) / 1_000_000 * point.outputPerM;

  return Number((baseInput + cachedInput + cacheCreate + output).toFixed(6));
}
