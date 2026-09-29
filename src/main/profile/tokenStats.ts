import {
  baseAgentKind,
  type ProfileBreakdownEntry,
  type ProfileStatsRequest,
  type ProfileTokenBreakdown,
  type ProfileTokenProvider,
  type ProfileTokenStats,
} from "@/shared/contracts";
import { priceTokens, PRICING_TABLE_REVIEWED, rateForModel } from "@poracode/agents-usage";
import { dbGetAllUsageEvents, getProfileDataGeneration } from "../db";
import {
  buildHeatmap,
  dayKeyFromIndex,
  HEATMAP_WINDOW_DAYS,
  localDayIndex,
  statsWindowDays,
  windowStartIndex,
} from "./heatmap";
import { recordCurrentDevice, resolveProfileDevice } from "./identity";
import { accountLabel, modelKey, modelLabel, providerLabel } from "./labels";

/**
 * Token usage from Poracode's own activity, read from the durable `usage_events`
 * log. Two row kinds feed the sums: kind="tokens_v2" (exact spend counted by the
 * main-process usage ledger from provider-reported counters) and kind="tokens"
 * (legacy per-turn deltas captured at the canonical-event layer — approximate
 * occupancy growth, kept for historical continuity). No external transcript
 * scanning, and no dependency on threads (survives delete/archive). Reported
 * both globally (folded to the base provider) and per account (each profile
 * separately).
 */

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function emptyBreakdown(): ProfileTokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

const TOKEN_CATEGORY_BY_KIND = {
  tokens_v2_input: "input",
  tokens_v2_output: "output",
  tokens_v2_cache_read: "cacheRead",
  tokens_v2_cache_write: "cacheWrite",
} as const;

type TokenCategory = (typeof TOKEN_CATEGORY_BY_KIND)[keyof typeof TOKEN_CATEGORY_BY_KIND];

function tokenCategory(kind: string): TokenCategory | undefined {
  return TOKEN_CATEGORY_BY_KIND[kind as keyof typeof TOKEN_CATEGORY_BY_KIND];
}

function addCategory(
  map: Map<string, ProfileTokenBreakdown>,
  key: string,
  category: TokenCategory,
  value: number,
): void {
  const current = map.get(key) ?? emptyBreakdown();
  current[category] += value;
  map.set(key, current);
}

function emptyTokenStats(
  device: ProfileTokenStats["device"],
  req: ProfileStatsRequest,
  nowMs: number,
  todayIndex: number,
): ProfileTokenStats {
  const windowDays = statsWindowDays(req.window) ?? HEATMAP_WINDOW_DAYS;
  const { heatmap } = buildHeatmap(new Map(), todayIndex, "tokens", windowDays);
  return {
    available: false,
    scope: req.scope ?? "device",
    device,
    generatedAt: nowMs,
    timezoneOffsetMinutes: req.utcOffsetMinutes,
    windowDays,
    lifetimeTokens: 0,
    breakdown: emptyBreakdown(),
    costBreakdownUsd: emptyBreakdown(),
    pricedTokens: 0,
    unpricedTokens: 0,
    pricingReviewedAt: PRICING_TABLE_REVIEWED,
    peakDayTokens: 0,
    providers: [],
    accounts: [],
    models: [],
    tokenHeatmap: heatmap,
    unavailableProviders: [],
  };
}

const tokenCache = new Map<string, { generation: number; result: ProfileTokenStats }>();

export function computeProfileTokenStats(req: ProfileStatsRequest): ProfileTokenStats {
  const offset = req.utcOffsetMinutes;
  const nowMs = Date.now();
  const todayIndex = localDayIndex(nowMs, offset);

  // Reuse the last aggregation until a usage write bumps the generation, so
  // repeated opens don't re-scan the log.
  const generation = getProfileDataGeneration();
  const cacheKey = `${offset}|${todayIndex}|${req.scope ?? "device"}|${req.deviceId ?? "current"}|${req.provider ?? "all"}|${req.window ?? "all"}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.generation === generation) return cached.result;

  const currentDevice = recordCurrentDevice();
  const targetDeviceId =
    req.scope === "all" ? currentDevice.id : (req.deviceId ?? currentDevice.id);
  if (targetDeviceId !== currentDevice.id) {
    const empty = emptyTokenStats(resolveProfileDevice(targetDeviceId), req, nowMs, todayIndex);
    tokenCache.set(cacheKey, { generation, result: empty });
    return empty;
  }

  const perDay = new Map<string, number>();
  const perProvider = new Map<string, number>();
  const perAccount = new Map<string, number>();
  const perModel = new Map<string, number>();
  const billable = emptyBreakdown();
  const billableByProvider = new Map<string, ProfileTokenBreakdown>();
  const billableByAccount = new Map<string, ProfileTokenBreakdown>();
  const costBreakdownUsd = emptyBreakdown();
  const costBreakdownByProvider = new Map<string, ProfileTokenBreakdown>();
  const costBreakdownByAccount = new Map<string, ProfileTokenBreakdown>();
  const costByProvider = new Map<string, number>();
  const costByAccount = new Map<string, number>();
  const pricedTokensByProvider = new Map<string, number>();
  const pricedTokensByAccount = new Map<string, number>();
  let estimatedCostUsd = 0;
  let pricedTokens = 0;
  // Coverage sets for the honesty list: providers that ran threads or turns vs
  // providers with at least one exact (tokens_v2) token row. A zero-value
  // tokens_v2 row still proves the provider reports exact usage. Computed over
  // the whole device log (ignoring the active account/window filters), but
  // activity only counts once the exact-telemetry era started on this device
  // (first tokens_v2 row) — otherwise every provider would flash "unavailable"
  // right after upgrade until it next records exact rows.
  const activityFirstTs = new Map<string, number>();
  const exactTokenProviders = new Set<string>();
  let firstExactTs: number | undefined;
  let lifetimeTokens = 0;
  const windowDays = statsWindowDays(req.window);
  const startDayIndex = windowDays ? windowStartIndex(todayIndex, windowDays) : undefined;

  for (const row of dbGetAllUsageEvents()) {
    if (row.provider) {
      const base = baseAgentKind(row.provider);
      if (row.kind === "tokens_v2") {
        exactTokenProviders.add(base);
        if (firstExactTs === undefined || row.ts < firstExactTs) firstExactTs = row.ts;
      } else if (row.kind === "thread_started" || row.kind === "turn") {
        const prev = activityFirstTs.get(base);
        if (prev === undefined || row.ts < prev) activityFirstTs.set(base, row.ts);
      }
    }
    // Scope to the selected account (exact account-kind match) when filtering.
    if (req.provider && row.provider !== req.provider) continue;
    const dayIndex = localDayIndex(row.ts, offset);
    if (startDayIndex !== undefined && (dayIndex < startDayIndex || dayIndex > todayIndex)) {
      continue;
    }
    const category = tokenCategory(row.kind);
    if (category && row.value > 0) {
      billable[category] += row.value;
      if (row.provider) {
        const base = baseAgentKind(row.provider);
        addCategory(billableByProvider, base, category, row.value);
        addCategory(billableByAccount, row.provider, category, row.value);
      }
      if (rateForModel(row.model ?? undefined)) {
        const categoryTokens = emptyBreakdown();
        categoryTokens[category] = row.value;
        const cost = priceTokens(row.model ?? undefined, categoryTokens);
        estimatedCostUsd += cost;
        costBreakdownUsd[category] += cost;
        pricedTokens += row.value;
        if (row.provider) {
          const base = baseAgentKind(row.provider);
          addCategory(costBreakdownByProvider, base, category, cost);
          addCategory(costBreakdownByAccount, row.provider, category, cost);
          costByProvider.set(base, (costByProvider.get(base) ?? 0) + cost);
          costByAccount.set(row.provider, (costByAccount.get(row.provider) ?? 0) + cost);
          pricedTokensByProvider.set(base, (pricedTokensByProvider.get(base) ?? 0) + row.value);
          pricedTokensByAccount.set(
            row.provider,
            (pricedTokensByAccount.get(row.provider) ?? 0) + row.value,
          );
        }
      }
      continue;
    }
    if ((row.kind !== "tokens" && row.kind !== "tokens_v2") || row.value <= 0) continue;
    lifetimeTokens += row.value;
    const day = dayKeyFromIndex(dayIndex);
    perDay.set(day, (perDay.get(day) ?? 0) + row.value);
    if (row.provider) {
      const base = baseAgentKind(row.provider);
      perProvider.set(base, (perProvider.get(base) ?? 0) + row.value);
      perAccount.set(row.provider, (perAccount.get(row.provider) ?? 0) + row.value);
    }
    if (row.model) {
      const key = modelKey(row.provider, row.model);
      perModel.set(key, (perModel.get(key) ?? 0) + row.value);
    }
  }

  const { heatmap: tokenHeatmap } = buildHeatmap(perDay, todayIndex, "tokens", windowDays);

  let peakDay: string | undefined;
  let peakDayTokens = 0;
  for (const [day, tokens] of perDay) {
    if (tokens > peakDayTokens) {
      peakDayTokens = tokens;
      peakDay = day;
    }
  }

  const providers: ProfileTokenProvider[] = [...perProvider.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([provider, tokens]) => {
      const providerPricedTokens = pricedTokensByProvider.get(provider) ?? 0;
      return {
        provider,
        label: providerLabel(provider),
        tokens,
        percent: lifetimeTokens > 0 ? round1((tokens / lifetimeTokens) * 100) : 0,
        ...(billableByProvider.has(provider)
          ? { breakdown: billableByProvider.get(provider)! }
          : {}),
        ...(providerPricedTokens > 0
          ? {
              pricedTokens: providerPricedTokens,
              estimatedCostUsd: costByProvider.get(provider) ?? 0,
              costBreakdownUsd: costBreakdownByProvider.get(provider) ?? emptyBreakdown(),
            }
          : {}),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const accounts: ProfileTokenProvider[] = [...perAccount.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([account, tokens]) => {
      const accountPricedTokens = pricedTokensByAccount.get(account) ?? 0;
      return {
        provider: account,
        label: accountLabel(account),
        tokens,
        percent: lifetimeTokens > 0 ? round1((tokens / lifetimeTokens) * 100) : 0,
        ...(billableByAccount.has(account) ? { breakdown: billableByAccount.get(account)! } : {}),
        ...(accountPricedTokens > 0
          ? {
              pricedTokens: accountPricedTokens,
              estimatedCostUsd: costByAccount.get(account) ?? 0,
              costBreakdownUsd: costBreakdownByAccount.get(account) ?? emptyBreakdown(),
            }
          : {}),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const models: ProfileBreakdownEntry[] = [...perModel.entries()]
    .map(([key, tokens]) => ({
      key,
      label: modelLabel(key),
      count: tokens,
      percent: lifetimeTokens > 0 ? round1((tokens / lifetimeTokens) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const unavailableProviders =
    firstExactTs === undefined
      ? []
      : [...activityFirstTs]
          .filter(
            ([provider, firstActivityTs]) =>
              firstActivityTs >= firstExactTs && !exactTokenProviders.has(provider),
          )
          .map(([provider]) => provider)
          .sort();

  const result: ProfileTokenStats = {
    available: lifetimeTokens > 0,
    scope: req.scope ?? "device",
    device: currentDevice,
    generatedAt: nowMs,
    timezoneOffsetMinutes: offset,
    windowDays: windowDays ?? HEATMAP_WINDOW_DAYS,
    lifetimeTokens,
    breakdown: billable,
    ...(pricedTokens > 0 ? { estimatedCostUsd } : {}),
    costBreakdownUsd,
    pricedTokens,
    unpricedTokens: Math.max(0, lifetimeTokens - pricedTokens),
    pricingReviewedAt: PRICING_TABLE_REVIEWED,
    peakDayTokens,
    ...(peakDay ? { peakDay } : {}),
    providers,
    accounts,
    models,
    tokenHeatmap,
    unavailableProviders,
  };
  tokenCache.set(cacheKey, { generation, result });
  return result;
}
