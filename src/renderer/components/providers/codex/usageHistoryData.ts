import { mergeCostEstimates, type CostEstimate } from "@poracode/agents-usage";
import type { UsageHistoryAggregate, UsageHistorySessionSummary } from "@/shared/contracts";

function compareSessions(a: UsageHistorySessionSummary, b: UsageHistorySessionSummary): number {
  return (
    b.fileSize - a.fileSize ||
    b.modifiedAt - a.modifiedAt ||
    b.fingerprint.localeCompare(a.fingerprint) ||
    a.sourceId.localeCompare(b.sourceId)
  );
}

/** One cross-machine winner per rollout session id, using the index selection contract. */
export function mergeUsageHistorySessions(
  groups: readonly (readonly UsageHistorySessionSummary[])[],
): UsageHistorySessionSummary[] {
  const candidates = new Map<string, UsageHistorySessionSummary[]>();
  for (const group of groups) {
    for (const session of group) {
      const entries = candidates.get(session.sessionId) ?? [];
      entries.push(session);
      candidates.set(session.sessionId, entries);
    }
  }
  return [...candidates.values()]
    .map((entries) => entries.sort(compareSessions)[0]!)
    .sort(
      (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId),
    );
}

export function aggregateUsageHistorySessions(
  sessions: readonly UsageHistorySessionSummary[],
): UsageHistoryAggregate | undefined {
  const estimates: CostEstimate[] = sessions.map((session) => ({
    cost: {
      currency: "USD",
      amount: session.estimatedCostUsd,
      period: "30d",
      estimated: true,
    },
    tokens: session.tokens,
    ...(session.history ? { history: session.history } : {}),
  }));
  const merged = mergeCostEstimates(estimates);
  if (!merged) return undefined;
  const reasoningTokens = (merged.history?.months ?? []).reduce(
    (total, month) => total + (month.reasoningTokens ?? 0),
    0,
  );
  return {
    tokens: merged.tokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    estimatedCostUsd: merged.cost.amount,
    ...(merged.history ? { history: merged.history } : {}),
  };
}
