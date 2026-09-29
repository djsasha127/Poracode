import type { UsageTokens } from "./types";

/**
 * Per-model USD prices per 1,000,000 tokens, used only when estimated cost is
 * enabled. These are PUBLIC API list rates, not subscription/OAuth charges —
 * always surface the result as an "API-rate equivalent".
 *
 * The table rots; treat it as a dated snapshot. The host/log-scanner (Poracode
 * phase 2) can also source rates dynamically (e.g. models.dev). Matching is by
 * longest substring of the model id.
 *
 * Last reviewed: 2026-09-29.
 */
export interface ModelRate {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

export const PRICING_TABLE_REVIEWED = "2026-09-29";
/** Increment when matching or rate semantics change without changing the review date. */
export const PRICING_TABLE_REVISION = "2026-09-29.2";

const RATES: Record<string, ModelRate> = {
  // Standard, short-context public API prices. Long-context and fast-mode
  // multipliers cannot be inferred from a subscription rollout log, so the UI
  // intentionally labels these values as an API-rate equivalent.
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  "claude-fable-5.1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  "fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-opus-5.5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-haiku-4.5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4.8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4.7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4.6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4.5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "gpt-6-astra": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "gpt-6-sol": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "gpt-5.6-sol": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheWrite: 2.5, cacheRead: 0.2 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheWrite: 0.25, cacheRead: 0.02 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25 },
  "gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  // Muse's public table has no separate cache-write SKU. Journal
  // `cache_write_tokens` are therefore non-cached input at the list input rate.
  "muse-spark-1.3-contributor": {
    input: 0.1,
    output: 0.2,
    cacheWrite: 0.1,
    cacheRead: 0.002,
  },
  "muse-spark-1.2-contributor": {
    input: 0.1,
    output: 0.2,
    cacheWrite: 0.1,
    cacheRead: 0.002,
  },
  "muse-spark-1.3": { input: 1.25, output: 4.25, cacheWrite: 1.25, cacheRead: 0.15 },
  "muse-spark-1.2": { input: 1.25, output: 4.25, cacheWrite: 1.25, cacheRead: 0.15 },
  "kimi-code/k3-256k": { input: 3, output: 15, cacheWrite: 3, cacheRead: 0.3 },
  "kimi-code/k3": { input: 3, output: 15, cacheWrite: 3, cacheRead: 0.3 },
  "kimi-k3-256k": { input: 3, output: 15, cacheWrite: 3, cacheRead: 0.3 },
  "kimi-k3": { input: 3, output: 15, cacheWrite: 3, cacheRead: 0.3 },
  "kimi-code/kimi-for-coding-highspeed": {
    input: 1.9,
    output: 8,
    cacheWrite: 1.9,
    cacheRead: 0.38,
  },
  "kimi-k2.7-code-highspeed": { input: 1.9, output: 8, cacheWrite: 1.9, cacheRead: 0.38 },
  "kimi-k2.7-code": { input: 0.95, output: 4, cacheWrite: 0.95, cacheRead: 0.19 },
};

/**
 * Subscription-only model ids have no dedicated API price. To still answer
 * "what would this token volume cost via API?", use the closest public API
 * category and expose that fact to the UI. gpt-5.5 is a ChatGPT model, so its
 * proxy is the official `chat-latest` short-context rate ($5 / $0.50 / $30).
 */
const PROXY_RATES: Record<string, ModelRate> = {
  // Internal automatic review runs currently expose no public underlying SKU.
  // Use the current Codex Fast-mode list rate and retain the proxy marker.
  "codex-auto-review": { input: 3.5, output: 28, cacheRead: 0.35 },
  // A minority of legacy Codex rows carry usage before any model context.
  // Their best current equivalent is the standard gpt-5.3-codex public rate.
  "codex-unknown": { input: 1.75, output: 14, cacheRead: 0.175 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
  // Kimi Code currently aliases `kimi-for-coding` to a subscription preview
  // model with no published PAYG row. Use the closest public Code rate and
  // keep it explicitly proxy-priced in the UI.
  "kimi-code/kimi-for-coding": {
    input: 0.95,
    output: 4,
    cacheWrite: 0.95,
    cacheRead: 0.19,
  },
};

export interface ResolvedModelRate {
  rate: ModelRate;
  kind: "official" | "proxy";
  matchedModel: string;
}

function longestRateMatch(
  modelId: string,
  rates: Readonly<Record<string, ModelRate>>,
): { key: string; rate: ModelRate } | undefined {
  let best: { key: string; rate: ModelRate } | undefined;
  for (const [key, rate] of Object.entries(rates)) {
    const matches =
      key === "gpt-5"
        ? modelId === key || /^gpt-5-\d{4}-\d{2}-\d{2}$/.test(modelId)
        : key === "gpt-4.1"
          ? modelId === key || /^gpt-4\.1-\d{4}-\d{2}-\d{2}$/.test(modelId)
          : modelId.includes(key);
    if (matches && (!best || key.length > best.key.length)) best = { key, rate };
  }
  return best;
}

/** Resolve a model rate together with whether it is official or a labeled proxy. */
export function resolveModelRate(modelId: string | undefined): ResolvedModelRate | undefined {
  if (!modelId) return undefined;
  const id = modelId.toLowerCase();
  const official = longestRateMatch(id, RATES);
  if (official) return { rate: official.rate, kind: "official", matchedModel: official.key };
  const proxy = longestRateMatch(id, PROXY_RATES);
  return proxy ? { rate: proxy.rate, kind: "proxy", matchedModel: proxy.key } : undefined;
}

/** Resolve the rate for a model id by longest matching key, or undefined. */
export function rateForModel(modelId: string | undefined): ModelRate | undefined {
  return resolveModelRate(modelId)?.rate;
}

/** Estimate USD cost for a token breakdown at the given model's list rates. */
export function priceTokens(modelId: string | undefined, tokens: UsageTokens): number {
  const rate = rateForModel(modelId);
  if (!rate) return 0;
  const perMillion = (count: number | undefined, price: number | undefined): number =>
    count && price ? (count / 1_000_000) * price : 0;
  return (
    perMillion(tokens.input, rate.input) +
    perMillion(tokens.output, rate.output) +
    perMillion(tokens.cacheWrite, rate.cacheWrite) +
    perMillion(tokens.cacheRead, rate.cacheRead)
  );
}
