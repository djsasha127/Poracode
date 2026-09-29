import { priceTokens, resolveModelRate } from "./pricing";
import type {
  UsageCost,
  UsageHistory,
  UsageHistoryModel,
  UsageHistoryMonth,
  UsageTokens,
} from "./types";

/**
 * Estimated spend + token totals reconstructed from local CLI session logs at
 * public API list rates. For subscription/OAuth users this is NOT the real
 * bill — surface it as "estimated". Pure: the caller supplies file contents;
 * disk I/O lives in the host.
 */
export interface CostEstimate {
  cost: UsageCost;
  tokens: UsageTokens;
  /** Model id with the largest cost contribution. */
  topModel?: string;
  /** Calendar-month transcript history, including model + reasoning effort. */
  history?: UsageHistory;
}

interface CodexLogLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    model?: string;
    effort?: string;
    thread_settings?: { model?: string; reasoning_effort?: string; effort?: string };
    response_id?: string;
    turn_id?: string;
    usage?: Record<string, unknown>;
    turn_token_usage?: Record<string, unknown>;
    info?: {
      last_token_usage?: Record<string, unknown>;
      total_token_usage?: Record<string, unknown>;
    };
  };
}

interface ClaudeAssistantLine {
  type?: string;
  requestId?: string;
  timestamp?: string;
  effort?: string;
  perTurnEffort?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageCostSample extends ModelTokens {
  timestampMs: number;
  model: string;
  effort?: string;
  /** Subset of output tokens, not added again to total tokens. */
  reasoningTokens?: number;
}

interface HistoryModelState extends ModelTokens {
  model: string;
  effort?: string;
  reasoningTokens: number;
}

export interface UsageCostAccumulator {
  add(sample: UsageCostSample): void;
  finish(): CostEstimate | undefined;
}

function pos(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function emptyModelTokens(): ModelTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addModelTokens(target: ModelTokens, value: ModelTokens): void {
  target.input += value.input;
  target.output += value.output;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
}

function totalModelTokens(tokens: ModelTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

function roundedUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function usageTokensFor(model: string, tokens: ModelTokens): UsageTokens {
  const total = totalModelTokens(tokens);
  const resolvedRate = resolveModelRate(model);
  return {
    total,
    ...tokens,
    priced: resolvedRate ? total : 0,
    proxyPriced: resolvedRate?.kind === "proxy" ? total : 0,
  };
}

function monthKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 7);
}

function historyGroupKey(model: string, effort: string | undefined): string {
  return `${model}\u0000${effort ?? ""}`;
}

function buildUsageHistory(
  history: ReadonlyMap<string, ReadonlyMap<string, HistoryModelState>>,
): UsageHistory | undefined {
  if (history.size === 0) return undefined;
  const months: UsageHistoryMonth[] = [];
  for (const [month, states] of history) {
    const monthTokens = emptyModelTokens();
    let reasoningTokens = 0;
    let estimatedCostUsd = 0;
    const models: UsageHistoryModel[] = [];
    for (const state of states.values()) {
      addModelTokens(monthTokens, state);
      reasoningTokens += state.reasoningTokens;
      const cost = roundedUsd(priceTokens(state.model, state));
      estimatedCostUsd += cost;
      models.push({
        model: state.model,
        ...(state.effort ? { effort: state.effort } : {}),
        tokens: usageTokensFor(state.model, state),
        ...(state.reasoningTokens > 0 ? { reasoningTokens: state.reasoningTokens } : {}),
        estimatedCostUsd: cost,
      });
    }
    models.sort(
      (a, b) =>
        b.estimatedCostUsd - a.estimatedCostUsd || (b.tokens.total ?? 0) - (a.tokens.total ?? 0),
    );
    const totals = emptyModelTokens();
    let priced = 0;
    let proxyPriced = 0;
    for (const model of models) {
      totals.input += model.tokens.input ?? 0;
      totals.output += model.tokens.output ?? 0;
      totals.cacheRead += model.tokens.cacheRead ?? 0;
      totals.cacheWrite += model.tokens.cacheWrite ?? 0;
      priced += model.tokens.priced ?? 0;
      proxyPriced += model.tokens.proxyPriced ?? 0;
    }
    months.push({
      month,
      tokens: {
        total: totalModelTokens(totals),
        ...totals,
        priced,
        proxyPriced,
      },
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      estimatedCostUsd: roundedUsd(estimatedCostUsd),
      models,
    });
  }
  months.sort((a, b) => b.month.localeCompare(a.month));
  return { months };
}

/** Generic accumulator used by provider-owned transcript parsers. */
export function createUsageCostAccumulator(opts: {
  sinceMs: number;
  nowMs: number;
  historySinceMs?: number;
}): UsageCostAccumulator {
  const recent = new Map<string, ModelTokens>();
  const history = new Map<string, Map<string, HistoryModelState>>();
  const historySinceMs = opts.historySinceMs ?? opts.sinceMs;
  return {
    add(sample): void {
      if (
        !Number.isFinite(sample.timestampMs) ||
        sample.timestampMs < historySinceMs ||
        sample.timestampMs > opts.nowMs
      ) {
        return;
      }
      const groupKey = historyGroupKey(sample.model, sample.effort);
      const month = monthKey(sample.timestampMs);
      const monthGroups = history.get(month) ?? new Map<string, HistoryModelState>();
      const historyEntry = monthGroups.get(groupKey) ?? {
        model: sample.model,
        ...(sample.effort ? { effort: sample.effort } : {}),
        ...emptyModelTokens(),
        reasoningTokens: 0,
      };
      addModelTokens(historyEntry, sample);
      historyEntry.reasoningTokens += sample.reasoningTokens ?? 0;
      monthGroups.set(groupKey, historyEntry);
      history.set(month, monthGroups);

      if (sample.timestampMs < opts.sinceMs) return;
      const recentEntry = recent.get(sample.model) ?? emptyModelTokens();
      addModelTokens(recentEntry, sample);
      recent.set(sample.model, recentEntry);
    },
    finish(): CostEstimate | undefined {
      return estimateFromModels(recent, buildUsageHistory(history));
    },
  };
}

function codexUsageTokens(usage: Record<string, unknown>): ModelTokens {
  const rawInput = pos(usage.input_tokens ?? usage.inputTokens);
  const cacheRead = pos(usage.cached_input_tokens ?? usage.cachedInputTokens);
  const cacheWrite = pos(usage.cache_write_input_tokens ?? usage.cacheWriteInputTokens);
  return {
    input: Math.max(0, rawInput - cacheRead - cacheWrite),
    output: pos(usage.output_tokens ?? usage.outputTokens),
    cacheRead,
    cacheWrite,
  };
}

function estimateFromModels(
  perModel: ReadonlyMap<string, ModelTokens>,
  history?: UsageHistory,
): CostEstimate | undefined {
  if (perModel.size === 0 && !history) return undefined;

  let amount = 0;
  let priced = 0;
  let proxyPriced = 0;
  const totals: ModelTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let topModel: string | undefined;
  let topCost = -1;
  for (const [model, tokens] of perModel) {
    const modelCost = priceTokens(model, tokens);
    const modelTokens = totalModelTokens(tokens);
    const resolvedRate = resolveModelRate(model);
    amount += modelCost;
    totals.input += tokens.input;
    totals.output += tokens.output;
    totals.cacheRead += tokens.cacheRead;
    totals.cacheWrite += tokens.cacheWrite;
    if (resolvedRate) {
      priced += modelTokens;
      if (resolvedRate.kind === "proxy") proxyPriced += modelTokens;
    }
    if (modelCost > topCost) {
      topCost = modelCost;
      topModel = model;
    }
  }

  const total = totalModelTokens(totals);
  return {
    cost: {
      currency: "USD",
      amount: roundedUsd(amount),
      period: "30d",
      estimated: true,
    },
    tokens: { total, ...totals, priced, proxyPriced, period: "30d" },
    ...(topModel ? { topModel } : {}),
    ...(history ? { history } : {}),
  };
}

function createClaudeCostParser(opts: { sinceMs: number; nowMs: number; historySinceMs?: number }) {
  const accumulator = createUsageCostAccumulator(opts);
  const seen = new Set<string>();

  return {
    addLine(rawLine: string): void {
      const line = rawLine.trim();
      if (line.length === 0 || line[0] !== "{") return;
      let parsed: ClaudeAssistantLine;
      try {
        parsed = JSON.parse(line) as ClaudeAssistantLine;
      } catch {
        return;
      }
      if (parsed.type !== "assistant") return;
      const usage = parsed.message?.usage;
      if (!usage) return;

      const messageId = parsed.message?.id ?? "";
      const requestId = parsed.requestId ?? "";
      if (messageId || requestId) {
        const key = `${messageId}:${requestId}`;
        if (seen.has(key)) return;
        seen.add(key);
      }

      const model = parsed.message?.model ?? "unknown";
      const timestampMs = parsed.timestamp ? Date.parse(parsed.timestamp) : opts.nowMs;
      const usageRecord = usage as Record<string, unknown>;
      const outputDetails = usageRecord.output_tokens_details as
        | Record<string, unknown>
        | undefined;
      const effort = stringValue(parsed.effort ?? parsed.perTurnEffort);
      const tokens = {
        input: pos(usage.input_tokens),
        output: pos(usage.output_tokens),
        cacheWrite: pos(usage.cache_creation_input_tokens),
        cacheRead: pos(usage.cache_read_input_tokens),
      };
      if (totalModelTokens(tokens) <= 0) return;
      accumulator.add({
        timestampMs,
        model,
        ...(effort ? { effort } : {}),
        ...tokens,
        ...(pos(outputDetails?.reasoning_tokens ?? outputDetails?.thinking_tokens) > 0
          ? {
              reasoningTokens: pos(
                outputDetails?.reasoning_tokens ?? outputDetails?.thinking_tokens,
              ),
            }
          : {}),
      });
    },
    finish(): CostEstimate | undefined {
      return accumulator.finish();
    },
  };
}

/**
 * Aggregate Claude Code session JSONL into an estimated 30-day cost + token
 * totals and optional calendar-month history. Dedups streamed chunks by
 * `messageId:requestId` (later cumulative chunks overwrite earlier ones).
 */
export function aggregateClaudeCost(
  contents: readonly string[],
  opts: { sinceMs: number; nowMs: number; historySinceMs?: number },
): CostEstimate | undefined {
  const parser = createClaudeCostParser(opts);
  for (const content of contents) {
    for (const rawLine of content.split("\n")) parser.addLine(rawLine);
  }
  return parser.finish();
}

/** Streaming variant used for large Claude transcript histories. */
export async function aggregateClaudeCostLines(
  lines: AsyncIterable<string>,
  opts: { sinceMs: number; nowMs: number; historySinceMs?: number },
): Promise<CostEstimate | undefined> {
  const parser = createClaudeCostParser(opts);
  for await (const line of lines) parser.addLine(line);
  return parser.finish();
}

/**
 * Aggregate Codex rollout JSONL into a 30-day API-equivalent estimate. Each
 * `token_usage_record.payload.usage` is the per-response delta, while
 * `turn_token_usage` is cumulative within the turn. Prefer the delta so a
 * tool-heavy turn is not counted repeatedly; response/turn ids provide
 * replay-safe dedup. The active model is taken from the preceding
 * `turn_context` / `thread_settings_applied` row in the same rollout.
 */
function createCodexCostParser(opts: { sinceMs: number; nowMs: number; historySinceMs?: number }) {
  const accumulator = createUsageCostAccumulator(opts);
  const seen = new Set<string>();
  let currentModel: string | undefined;
  let currentEffort: string | undefined;
  let legacySamples: UsageCostSample[] = [];
  let earliestNativeRecordMs: number | undefined;

  const applyCurrentContextToPendingLegacySamples = (): void => {
    if (!currentModel && !currentEffort) return;
    legacySamples = legacySamples.map((sample) => ({
      ...sample,
      ...(sample.model === "codex-unknown" && currentModel ? { model: currentModel } : {}),
      ...(!sample.effort && currentEffort ? { effort: currentEffort } : {}),
    }));
  };

  const flushLegacySamples = (): void => {
    for (const sample of legacySamples) {
      // Older rollouts emitted only `event_msg/token_count`. Newer builds emit
      // that compatibility event alongside `token_usage_record`; once native
      // records begin in a file, count only legacy samples strictly before the
      // first native record so the overlap is never doubled.
      if (earliestNativeRecordMs === undefined || sample.timestampMs < earliestNativeRecordMs) {
        accumulator.add(sample);
      }
    }
    legacySamples = [];
    earliestNativeRecordMs = undefined;
  };

  return {
    resetFile(): void {
      flushLegacySamples();
      currentModel = undefined;
      currentEffort = undefined;
    },
    addLine(rawLine: string): void {
      const line = rawLine.trim();
      if (line.length === 0 || line[0] !== "{") return;
      let parsed: CodexLogLine;
      try {
        parsed = JSON.parse(line) as CodexLogLine;
      } catch {
        return;
      }
      if (parsed.type === "turn_context") {
        currentModel = stringValue(parsed.payload?.model) ?? currentModel;
        currentEffort = stringValue(parsed.payload?.effort) ?? currentEffort;
        applyCurrentContextToPendingLegacySamples();
        return;
      }
      if (parsed.type === "event_msg" && parsed.payload?.type === "thread_settings_applied") {
        currentModel = stringValue(parsed.payload.thread_settings?.model) ?? currentModel;
        currentEffort =
          stringValue(
            parsed.payload.thread_settings?.reasoning_effort ??
              parsed.payload.thread_settings?.effort,
          ) ?? currentEffort;
        applyCurrentContextToPendingLegacySamples();
        return;
      }
      if (parsed.type === "event_msg" && parsed.payload?.type === "token_count") {
        const usage = parsed.payload.info?.last_token_usage;
        if (!usage) return;
        const tokens = codexUsageTokens(usage);
        if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite <= 0) return;
        const timestampMs = parsed.timestamp ? Date.parse(parsed.timestamp) : opts.nowMs;
        legacySamples.push({
          timestampMs,
          model: currentModel ?? "codex-unknown",
          ...(currentEffort ? { effort: currentEffort } : {}),
          ...tokens,
          ...(pos(usage.reasoning_output_tokens ?? usage.reasoningTokens) > 0
            ? {
                reasoningTokens: pos(usage.reasoning_output_tokens ?? usage.reasoningTokens),
              }
            : {}),
        });
        return;
      }
      if (parsed.type !== "token_usage_record") return;
      const usage = parsed.payload?.usage ?? parsed.payload?.turn_token_usage;
      if (!usage) return;
      const sampleId =
        stringValue(parsed.payload?.response_id) ??
        stringValue(parsed.payload?.turn_id) ??
        `${parsed.timestamp ?? "unknown"}:${rawLine.length}`;
      if (seen.has(sampleId)) return;
      seen.add(sampleId);

      const tokens = codexUsageTokens(usage);
      if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite <= 0) return;
      const timestampMs = parsed.timestamp ? Date.parse(parsed.timestamp) : opts.nowMs;
      if (Number.isFinite(timestampMs)) {
        earliestNativeRecordMs = Math.min(earliestNativeRecordMs ?? timestampMs, timestampMs);
      }
      accumulator.add({
        timestampMs,
        model: currentModel ?? "codex-unknown",
        ...(currentEffort ? { effort: currentEffort } : {}),
        ...tokens,
        ...(pos(usage.reasoning_output_tokens ?? usage.reasoningTokens) > 0
          ? {
              reasoningTokens: pos(usage.reasoning_output_tokens ?? usage.reasoningTokens),
            }
          : {}),
      });
    },
    finish(): CostEstimate | undefined {
      flushLegacySamples();
      return accumulator.finish();
    },
  };
}

export function aggregateCodexCost(
  contents: readonly string[],
  opts: { sinceMs: number; nowMs: number; historySinceMs?: number },
): CostEstimate | undefined {
  const parser = createCodexCostParser(opts);
  for (const content of contents) {
    parser.resetFile();
    for (const rawLine of content.split("\n")) parser.addLine(rawLine);
  }
  return parser.finish();
}

/** Streaming variant used for multi-gigabyte Codex rollout histories. */
export async function aggregateCodexCostLines(
  lines: AsyncIterable<string>,
  opts: { sinceMs: number; nowMs: number; historySinceMs?: number },
): Promise<CostEstimate | undefined> {
  const parser = createCodexCostParser(opts);
  parser.resetFile();
  for await (const line of lines) parser.addLine(line);
  return parser.finish();
}

/** Add independently parsed file estimates without loading their source logs together. */
export function mergeCostEstimates(
  estimates: readonly (CostEstimate | undefined)[],
): CostEstimate | undefined {
  const present = estimates.filter((entry): entry is CostEstimate => Boolean(entry));
  if (present.length === 0) return undefined;

  const sumToken = (key: keyof UsageTokens): number =>
    present.reduce(
      (sum, entry) => sum + (typeof entry.tokens[key] === "number" ? entry.tokens[key] : 0),
      0,
    );
  const amount = present.reduce((sum, entry) => sum + entry.cost.amount, 0);
  const top = present.reduce<CostEstimate | undefined>(
    (best, entry) => (!best || entry.cost.amount > best.cost.amount ? entry : best),
    undefined,
  );
  const historyMonths = new Map<string, Map<string, UsageHistoryModel>>();
  for (const entry of present) {
    for (const month of entry.history?.months ?? []) {
      const modelGroups = historyMonths.get(month.month) ?? new Map<string, UsageHistoryModel>();
      for (const model of month.models) {
        const key = historyGroupKey(model.model, model.effort);
        const previous = modelGroups.get(key);
        if (!previous) {
          modelGroups.set(key, {
            ...model,
            tokens: { ...model.tokens },
          });
          continue;
        }
        modelGroups.set(key, {
          model: model.model,
          ...(model.effort ? { effort: model.effort } : {}),
          tokens: {
            total: (previous.tokens.total ?? 0) + (model.tokens.total ?? 0),
            input: (previous.tokens.input ?? 0) + (model.tokens.input ?? 0),
            output: (previous.tokens.output ?? 0) + (model.tokens.output ?? 0),
            cacheRead: (previous.tokens.cacheRead ?? 0) + (model.tokens.cacheRead ?? 0),
            cacheWrite: (previous.tokens.cacheWrite ?? 0) + (model.tokens.cacheWrite ?? 0),
            priced: (previous.tokens.priced ?? 0) + (model.tokens.priced ?? 0),
            proxyPriced: (previous.tokens.proxyPriced ?? 0) + (model.tokens.proxyPriced ?? 0),
          },
          ...((previous.reasoningTokens ?? 0) + (model.reasoningTokens ?? 0) > 0
            ? {
                reasoningTokens: (previous.reasoningTokens ?? 0) + (model.reasoningTokens ?? 0),
              }
            : {}),
          estimatedCostUsd: roundedUsd(previous.estimatedCostUsd + model.estimatedCostUsd),
        });
      }
      historyMonths.set(month.month, modelGroups);
    }
  }
  const mergedHistory = buildUsageHistoryFromModels(historyMonths);
  return {
    cost: {
      currency: "USD",
      amount: Math.round(amount * 1_000_000) / 1_000_000,
      period: "30d",
      estimated: true,
    } satisfies UsageCost,
    tokens: {
      total: sumToken("total"),
      input: sumToken("input"),
      output: sumToken("output"),
      cacheRead: sumToken("cacheRead"),
      cacheWrite: sumToken("cacheWrite"),
      priced: sumToken("priced"),
      proxyPriced: sumToken("proxyPriced"),
      period: "30d",
    } satisfies UsageTokens,
    ...(top?.topModel ? { topModel: top.topModel } : {}),
    ...(mergedHistory ? { history: mergedHistory } : {}),
  };
}

function buildUsageHistoryFromModels(
  history: ReadonlyMap<string, ReadonlyMap<string, UsageHistoryModel>>,
): UsageHistory | undefined {
  if (history.size === 0) return undefined;
  const months: UsageHistoryMonth[] = [];
  for (const [month, modelsByKey] of history) {
    const models = [...modelsByKey.values()].sort(
      (a, b) =>
        b.estimatedCostUsd - a.estimatedCostUsd || (b.tokens.total ?? 0) - (a.tokens.total ?? 0),
    );
    const tokens: UsageTokens = {
      total: models.reduce((sum, model) => sum + (model.tokens.total ?? 0), 0),
      input: models.reduce((sum, model) => sum + (model.tokens.input ?? 0), 0),
      output: models.reduce((sum, model) => sum + (model.tokens.output ?? 0), 0),
      cacheRead: models.reduce((sum, model) => sum + (model.tokens.cacheRead ?? 0), 0),
      cacheWrite: models.reduce((sum, model) => sum + (model.tokens.cacheWrite ?? 0), 0),
      priced: models.reduce((sum, model) => sum + (model.tokens.priced ?? 0), 0),
      proxyPriced: models.reduce((sum, model) => sum + (model.tokens.proxyPriced ?? 0), 0),
    };
    const reasoningTokens = models.reduce((sum, model) => sum + (model.reasoningTokens ?? 0), 0);
    months.push({
      month,
      tokens,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      estimatedCostUsd: roundedUsd(models.reduce((sum, model) => sum + model.estimatedCostUsd, 0)),
      models,
    });
  }
  months.sort((a, b) => b.month.localeCompare(a.month));
  return { months };
}
